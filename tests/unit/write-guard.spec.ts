/**
 * 写路径安全网：备份、条目数校验、回滚。
 *
 * 这一层刻意不碰真文件系统：`WriteGuardIO` 全注入，所以"备份失败"「文件被截断」
 * 「读不回来」这些**只在事故当天才出现**的情形，可以在这里直接构造出来断言。
 *
 * 最该被钉死的一条：`judgeWrite` 必须把 **34 条目 → 3 条目** 判为异常 ——
 * 那正是 2026-10-08 真实发生的事故形态。
 */

import { basename, dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  BACKUP_DIR_NAME,
  countPatchEntries,
  DEFAULT_KEEP_BACKUPS,
  defaultBackupDir,
  judgeWrite,
  probeEntryCount,
  rollbackPatch,
  snapshotPatch,
  type WriteGuardIO,
  type WriteGuardSnapshot,
} from '../../src/write-guard.js'

/** 内存文件系统替身：按绝对路径存字符串。 */
interface MemIO extends WriteGuardIO {
  files: Record<string, string>
  mkdirs: string[]
}

function memIO(initial: Record<string, string> = {}): MemIO {
  const files: Record<string, string> = { ...initial }
  const mkdirs: string[] = []
  const enoent = (path: string): Error => {
    const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & { code?: string }
    error.code = 'ENOENT'
    return error
  }
  return {
    files,
    mkdirs,
    async readFile(path) {
      if (!Object.hasOwn(files, path)) throw enoent(path)
      return files[path] as string
    },
    async writeFile(path, data) { files[path] = data },
    async copyFile(from, to) {
      if (!Object.hasOwn(files, from)) throw enoent(from)
      files[to] = files[from] as string
    },
    async mkdir(path) { mkdirs.push(path) },
    async listDir(path) {
      return Object.keys(files).filter(key => dirname(key) === path).map(key => basename(key))
    },
    async remove(path) { Reflect.deleteProperty(files, path) },
  }
}

/** 一份贴近真实的 patch：三种条目形态（带 config / 裸条目 / insert 里的条目）。 */
const REAL_PATCH = [
  '- id: llm-pi-ai',
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  '  config:',
  '    providers:',
  '      workbuddy:',
  '        models: []',
  '- id: subagent-router',
  "  name: 'dsh-subagent-router'",
  '- insert:',
  '    - id: rea-mcp',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '',
].join('\n')

const PATCH = 'C:\\fake\\.dsh\\profiles\\desktop\\cordis.patch.yml'
const BACKUP_DIR = 'C:\\fake\\.dsh\\wb2api-write-backups'

/** 造一个基线快照。 */
const snapshot = (entryCount: number, backupPath = 'C:\\fake\\bak'): WriteGuardSnapshot => ({
  backupPath,
  entryCount,
  bytes: entryCount * 1869,
})

describe('countPatchEntries', () => {
  it('数出所有形态的条目（含 insert 里缩进的那条）', () => {
    expect(countPatchEntries(REAL_PATCH)).toBe(3)
  })

  it('忽略注释与缩进不同的非条目行', () => {
    expect(countPatchEntries('# - id: not-an-entry\nsome: key\n  - id: real\n')).toBe(1)
  })

  it('文件被截断成空/垃圾时数出 0，而不是抛错（坏文件也要能量出来）', () => {
    expect(countPatchEntries('')).toBe(0)
    expect(countPatchEntries('\u0000\u0001garbage')).toBe(0)
  })

  it('`- id:` 后面没有值的不算条目', () => {
    expect(countPatchEntries('- id:\n- id:   \n')).toBe(0)
  })

  it('🔴 provider 的模型 id（缩进 10）不算 profile 条目 —— 2026-10-12 实测发现的缺陷', () => {
    // 若把模型 id 一起数，--rebuild 在网关下架模型时会让计数变小，
    // 于是被 judgeWrite 误判成"文件被截断"而回滚 —— 那个命令在下架时就废了。
    const patch = [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      workbuddy:',
      '        models:',
      '          - id: cn:a',
      '          - id: cn:b',
      '          - id: cn:c',
      '- id: subagent-router',
      '',
    ].join('\n')
    // 只有 llm-pi-ai 与 subagent-router 两个 **profile 条目**。
    expect(countPatchEntries(patch)).toBe(2)
  })

  it('insert 列表里的条目（缩进 4）要算进来', () => {
    const patch = ['- insert:', '    - id: mcp-exa', "      name: 'x'", ''].join('\n')
    expect(countPatchEntries(patch)).toBe(1)
  })

  it('顶层条目 + insert 条目 + 模型 id 混在一起时只数前两者', () => {
    // 贴近 live 的真实形状：顶层条目、insert 条目、provider 模型三者并存。
    expect(countPatchEntries(REAL_PATCH)).toBe(3)
    expect(countPatchEntries(
      ['- insert:', '    - id: a', '- id: b', '      workbuddy:', '        models:', '          - id: cn:x', ''].join('\n'),
    )).toBe(2)
  })
})

describe('judgeWrite', () => {
  it('🔴 34 条目 → 3 条目 必须判为异常（2026-10-08 的事故形态）', () => {
    const verdict = judgeWrite(snapshot(34), { entryCount: 3, providerPresent: true, modelCount: 26 }, { modelCount: 26 })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.reasons.join('\n')).toContain('34')
    expect(verdict.reasons.join('\n')).toContain('3')
    expect(verdict.entryCount).toBe(3)
  })

  it('写入正常时通过', () => {
    const verdict = judgeWrite(snapshot(34), { entryCount: 34, providerPresent: true, modelCount: 26 }, { modelCount: 26 })
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.entryCount).toBe(34)
  })

  it('条目变多不算异常（别的插件同时在写自己的段）', () => {
    expect(judgeWrite(snapshot(34), { entryCount: 35, providerPresent: true, modelCount: 5 }, { modelCount: 5 }).ok).toBe(true)
  })

  it('provider 没落地 → 异常', () => {
    const verdict = judgeWrite(snapshot(34), { entryCount: 34, providerPresent: false, modelCount: 0 }, { modelCount: 26 })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join()).toContain('没有落地')
  })

  it('provider 在但模型数不符 → 异常', () => {
    const verdict = judgeWrite(snapshot(34), { entryCount: 34, providerPresent: true, modelCount: 3 }, { modelCount: 26 })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join()).toContain('模型数不符')
  })

  it('🔴 读不回文件 → 判异常，绝不当作通过（无法确认 ≠ 确认无误）', () => {
    const verdict = judgeWrite(snapshot(34), { providerPresent: true, modelCount: 26 }, { modelCount: 26 })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reasons.join()).toContain('无法确认')
      expect(verdict.entryCount).toBeUndefined()
    }
  })

  it('一次命中多条原因时全部列出（条目被截断 + provider 没落地 = 两条独立规则）', () => {
    const verdict = judgeWrite(snapshot(34), { entryCount: 3, providerPresent: false, modelCount: 0 }, { modelCount: 26 })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.reasons).toHaveLength(2)
    expect(verdict.reasons.join('\n')).toContain('条目数变少')
    expect(verdict.reasons.join('\n')).toContain('没有落地')
  })

  it('provider 根本不存在时不再追报"模型数不符"（不存在的东西谈不上模型数）', () => {
    const onlyMissing = judgeWrite(snapshot(34), { entryCount: 34, providerPresent: false, modelCount: 0 }, { modelCount: 26 })
    expect(onlyMissing.ok).toBe(false)
    if (!onlyMissing.ok) expect(onlyMissing.reasons.join()).not.toContain('模型数不符')
  })

  it('🔴 合法地减少模型数（网关下架 + --rebuild）不该触发回滚', () => {
    // profile 条目数没变（12 → 12），只是这个 provider 的模型从 30 变 10 ——
    // 这正是 --rebuild 面对"网关下架"时的**正常**结果，必须放行。
    const verdict = judgeWrite(snapshot(12), { entryCount: 12, providerPresent: true, modelCount: 10 }, { modelCount: 10 })
    expect(verdict.ok).toBe(true)
  })
})

describe('snapshotPatch', () => {
  it('把 patch 整份复制到备份目录，并记下条目数', async () => {
    const io = memIO({ [PATCH]: REAL_PATCH })
    const snap = await snapshotPatch({ patchPath: PATCH, backupDir: BACKUP_DIR, io, now: () => Date.UTC(2026, 9, 12, 8, 26, 42) })
    expect(snap.entryCount).toBe(3)
    expect(io.files[snap.backupPath]).toBe(REAL_PATCH)
    expect(snap.backupPath.startsWith(BACKUP_DIR)).toBe(true)
    expect(snap.backupPath).toContain('before-write-20261012-')
    expect(snap.backupPath).toContain('3entries')
  })

  it('备份目录不存在就先建出来', async () => {
    const io = memIO({ [PATCH]: REAL_PATCH })
    await snapshotPatch({ patchPath: PATCH, backupDir: BACKUP_DIR, io })
    expect(io.mkdirs).toContain(BACKUP_DIR)
  })

  it('🔴 patch 读不到 → 抛错（备份不了就不许写，不是"先写再说"）', async () => {
    const io = memIO()
    await expect(snapshotPatch({ patchPath: PATCH, backupDir: BACKUP_DIR, io })).rejects.toThrow(/ENOENT/)
  })

  it('🔴 复制失败 → 抛错，绝不留一个"以为备份好了"的假象', async () => {
    const io = memIO({ [PATCH]: REAL_PATCH })
    io.copyFile = vi.fn().mockRejectedValue(new Error('EACCES'))
    await expect(snapshotPatch({ patchPath: PATCH, backupDir: BACKUP_DIR, io })).rejects.toThrow('EACCES')
  })

  it('只保留最新 N 份备份（备份目录不能无限膨胀）', async () => {
    const io = memIO({ [PATCH]: REAL_PATCH })
    const stamps = [1, 2, 3, 4, 5].map(day => Date.UTC(2026, 9, day, 0, 0, 0))
    for (const ms of stamps) {
      await snapshotPatch({ patchPath: PATCH, backupDir: BACKUP_DIR, io, now: () => ms, keep: 2 })
    }
    const backups = Object.keys(io.files).filter(key => key.startsWith(BACKUP_DIR))
    expect(backups).toHaveLength(2)
    // 留下的必须是最新两份（10-04 与 10-05）。
    expect(backups.some(key => key.includes('20261005'))).toBe(true)
    expect(backups.some(key => key.includes('20261004'))).toBe(true)
  })

  it('整理备份时出错不影响本次备份已经成功这件事', async () => {
    const io = memIO({ [PATCH]: REAL_PATCH })
    io.listDir = vi.fn().mockRejectedValue(new Error('EPERM'))
    const snap = await snapshotPatch({ patchPath: PATCH, backupDir: BACKUP_DIR, io })
    expect(io.files[snap.backupPath]).toBe(REAL_PATCH)
  })

  it('默认保留份数是 20', () => {
    expect(DEFAULT_KEEP_BACKUPS).toBe(20)
  })
})

describe('rollbackPatch', () => {
  it('把备份整份盖回 patch（34 条被截成 3 条后恢复）', async () => {
    const io = memIO({ [PATCH]: REAL_PATCH })
    const snap = await snapshotPatch({ patchPath: PATCH, backupDir: BACKUP_DIR, io })
    io.files[PATCH] = '- id: llm-pi-ai\n'
    expect(countPatchEntries(io.files[PATCH] as string)).toBe(1)
    await rollbackPatch({ patchPath: PATCH, backupDir: BACKUP_DIR, io }, snap)
    expect(io.files[PATCH]).toBe(REAL_PATCH)
    expect(countPatchEntries(io.files[PATCH] as string)).toBe(3)
  })

  it('备份丢了就抛错，不静默把空内容写进去', async () => {
    const io = memIO({ [PATCH]: REAL_PATCH })
    const snap = await snapshotPatch({ patchPath: PATCH, backupDir: BACKUP_DIR, io })
    Reflect.deleteProperty(io.files, snap.backupPath)
    await expect(rollbackPatch({ patchPath: PATCH, backupDir: BACKUP_DIR, io }, snap)).rejects.toThrow(/ENOENT/)
  })
})

describe('probeEntryCount', () => {
  it('独立读文件数条目（不复用 settings.describe，因为要抓的是磁盘）', async () => {
    const io = memIO({ [PATCH]: REAL_PATCH })
    expect(await probeEntryCount({ patchPath: PATCH, backupDir: BACKUP_DIR, io })).toBe(3)
  })

  it('文件不在 → undefined（交给 judgeWrite 判成"无法确认"）', async () => {
    const io = memIO()
    expect(await probeEntryCount({ patchPath: PATCH, backupDir: BACKUP_DIR, io })).toBeUndefined()
  })
})

describe('defaultBackupDir', () => {
  it('落在 DSH home 之下、profile 目录之外', () => {
    const home = 'C:\\fake\\.dsh'
    const dir = defaultBackupDir(home)
    expect(dir).toBe(`${home}\\${BACKUP_DIR_NAME}`)
    // 铁律 ①：备份绝不能落进 profiles\<name>\ 里面。
    expect(dir).not.toContain('profiles')
  })
})

describe('整条安全网串起来（故障注入）', () => {
  it('写入把 34 条截成 3 条 → 判定异常 → 盖回 → patch 恢复原样', async () => {
    // 造一份 34 条目的 patch，模仿 live 的正本。
    const original = Array.from({ length: 34 }, (_, i) => `- id: entry-${i}\n`).join('')
    const io = memIO({ [PATCH]: original })
    const options = { patchPath: PATCH, backupDir: BACKUP_DIR, io }

    const snap = await snapshotPatch(options)
    expect(snap.entryCount).toBe(34)

    // 模拟那次 mutate：返回成功，但文件被整份重写。
    io.files[PATCH] = '- id: entry-0\n- id: entry-1\n- id: entry-2\n'

    const verdict = judgeWrite(
      snap,
      { entryCount: await probeEntryCount(options), providerPresent: true, modelCount: 26 },
      { modelCount: 26 },
    )
    expect(verdict.ok).toBe(false)

    await rollbackPatch(options, snap)
    expect(countPatchEntries(io.files[PATCH] as string)).toBe(34)
    expect(io.files[PATCH]).toBe(original)
  })
})
