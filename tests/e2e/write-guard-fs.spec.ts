/**
 * 写路径安全网在**真文件系统**上的行为。
 *
 * 单测用的是内存替身，它把 `copyFile` / `mkdir` / `readdir` 都自己"实现"了一遍 ——
 * 也就是说那里验证的是**我们的判定逻辑**，不是**文件真的被复制了**。这个 e2e 补上后者：
 * 真临时目录、真 patch、真备份、真回滚、真保留策略。
 *
 * 这一层存在的理由与 PROJECT.md §0 那条规矩同源：
 * **"逻辑对 + 单测全过"不足以证明一个写用户配置的能力是安全的** ——
 * 2026-10-08 就是这么栽的（0.4.0 单测全过，而真 mutate 从没跑过）。
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  countPatchEntries,
  defaultBackupDir,
  judgeWrite,
  probeEntryCount,
  rollbackPatch,
  snapshotPatch,
} from '../../src/write-guard.js'

/** 造一份 34 条目的 patch，模仿 live 正本的形状。 */
function liveLikePatch(): string {
  const rows = Array.from({ length: 34 }, (_, i) => [
    `- id: plugin-${String(i).padStart(2, '0')}`,
    `  name: '@deepseek-ai/dsh-plugin-${i}'`,
    '  config:',
    `    level: ${i}`,
  ].join('\n'))
  return `${rows.join('\n')}\n`
}

describe('写路径安全网（真文件系统）', () => {
  let root: string
  let profileDir: string
  let patchPath: string
  let backupDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wb2api-guard-'))
    // 刻意复刻真实布局：home 之下有 profiles/<name>/，备份落在 home 之下、profile 之外。
    profileDir = join(root, 'profiles', 'zzmutate')
    await mkdir(profileDir, { recursive: true })
    patchPath = join(profileDir, 'cordis.patch.yml')
    backupDir = defaultBackupDir(root)
    await writeFile(patchPath, liveLikePatch(), 'utf8')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('真备份：副本存在、逐字节一致、且落在 profile 之外', async () => {
    const options = { patchPath, backupDir }
    const snap = await snapshotPatch(options)

    expect(snap.entryCount).toBe(34)
    expect(existsSync(snap.backupPath)).toBe(true)
    expect(await readFile(snap.backupPath, 'utf8')).toBe(await readFile(patchPath, 'utf8'))
    // ★ 铁律 ①：备份绝不能落在 profile 目录里面。
    expect(snap.backupPath.startsWith(profileDir)).toBe(false)
    expect(snap.backupPath.startsWith(backupDir)).toBe(true)
    expect(snap.bytes).toBe((await stat(patchPath)).size)
  })

  it('🔴 文件被截断 → 探针发现条目变少 → 回滚后逐字节还原', async () => {
    const options = { patchPath, backupDir }
    const original = await readFile(patchPath, 'utf8')
    const snap = await snapshotPatch(options)

    // 模拟 2026-10-08 的形态：mutate "成功"，而文件已经变成 3 条。
    await writeFile(patchPath, '- id: plugin-00\n- id: plugin-01\n- id: plugin-02\n', 'utf8')

    const verdict = judgeWrite(
      snap,
      { entryCount: await probeEntryCount(options), providerPresent: true, modelCount: 26 },
      { modelCount: 26 },
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join('\n')).toContain('34')

    await rollbackPatch(options, snap)
    expect(await readFile(patchPath, 'utf8')).toBe(original)
    expect(countPatchEntries(await readFile(patchPath, 'utf8'))).toBe(34)
  })

  it('正常写入（条目数与模型数都对）→ 判定通过，备份留着不删', async () => {
    const options = { patchPath, backupDir }
    const snap = await snapshotPatch(options)
    const verdict = judgeWrite(
      snap,
      { entryCount: await probeEntryCount(options), providerPresent: true, modelCount: 26 },
      { modelCount: 26 },
    )
    expect(verdict.ok).toBe(true)
    expect(existsSync(snap.backupPath)).toBe(true)
  })

  it('🔴 文件被删掉 → 探针 undefined → 判异常（无法确认 ≠ 通过）', async () => {
    const options = { patchPath, backupDir }
    const snap = await snapshotPatch(options)
    await rm(patchPath, { force: true })
    const verdict = judgeWrite(
      snap,
      { entryCount: await probeEntryCount(options), providerPresent: true, modelCount: 26 },
      { modelCount: 26 },
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reasons.join()).toContain('无法确认')
  })

  it('patch 不存在时备份直接抛错（备份不了就不许写）', async () => {
    await rm(patchPath, { force: true })
    await expect(snapshotPatch({ patchPath, backupDir })).rejects.toThrow()
  })

  it('备份保留策略真在磁盘上删除旧文件', async () => {
    // 用固定时间戳，保证文件名只差时间、可稳定排序。
    for (const day of [1, 2, 3, 4, 5]) {
      await snapshotPatch({ patchPath, backupDir, keep: 2, now: () => Date.UTC(2026, 9, day, 0, 0, 0) })
    }
    const names = (await readdir(backupDir)).filter(name => name.startsWith('cordis.patch.yml.before-write-'))
    expect(names).toHaveLength(2)
    // 留下的必须是最新两份。
    expect(names.some(name => name.includes('20261005'))).toBe(true)
    expect(names.some(name => name.includes('20261004'))).toBe(true)
  })

  it('回滚用的备份丢了 → 抛错，绝不把空内容盖上去', async () => {
    const options = { patchPath, backupDir }
    const snap = await snapshotPatch(options)
    await rm(snap.backupPath, { force: true })
    const before = await readFile(patchPath, 'utf8')
    await expect(rollbackPatch(options, snap)).rejects.toThrow()
    // 抛错之后正本必须原封不动。
    expect(await readFile(patchPath, 'utf8')).toBe(before)
  })
})
