/**
 * 插件自己的状态文件（墓碑集合）。
 *
 * 这一层的三条硬要求，每条都有用例钉住：
 *   ① 落点是 `<DSH_HOME>/.wb2api/state.json`（**有点**），绝不与网关的 `~/.dsh/wb2api/` 撞；
 *   ② 读：文件不存在 / JSON 坏 / 结构不对 ⇒ 当「没有记录」（`undefined`），**绝不抛**；
 *      且「没有记录」与「记录是空数组」必须分得开；
 *   ③ 拿不到 home ⇒ 返回 `undefined`（调用方据此不启用墓碑），**不是**抛错。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeIds,
  openTombstone,
  readOffered,
  readStateFile,
  resolveStateLocation,
  STATE_DIR_NAME,
  STATE_FILE_NAME,
  STATE_SCHEMA_VERSION,
  stateFilePath,
  writeOffered,
} from '../../src/plugin-state.js'

const temps: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb2api-state-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveStateLocation', () => {
  it('profileContext.home 优先', () => {
    const location = resolveStateLocation({
      profileHome: 'C:\\temp\\home',
      env: { DSH_HOME: 'D:\\other' },
      homedir: () => 'C:\\Users\\nobody',
    })
    expect(location).toEqual({
      home: 'C:\\temp\\home',
      path: join('C:\\temp\\home', '.wb2api', 'state.json'),
      source: 'profile',
    })
  })

  it('没有 profileContext 时退到环境变量 DSH_HOME', () => {
    const location = resolveStateLocation({ env: { DSH_HOME: 'D:\\iso\\home' }, homedir: () => 'C:\\Users\\nobody' })
    expect(location?.source).toBe('env')
    expect(location?.home).toBe('D:\\iso\\home')
  })

  it('两个都没有时退到 ~/.dsh（DSH 自己的默认值）', () => {
    const location = resolveStateLocation({ env: {}, homedir: () => 'C:\\Users\\rumil' })
    expect(location?.source).toBe('default')
    expect(location?.home).toBe(join('C:\\Users\\rumil', '.dsh'))
  })

  it('🔴 一条都拿不到时返回 undefined（降级为「不启用墓碑」），绝不抛错', () => {
    expect(resolveStateLocation({ profileHome: '', env: {}, homedir: () => undefined })).toBeUndefined()
    expect(resolveStateLocation({ profileHome: '   ', env: { DSH_HOME: '  ' }, homedir: () => '' })).toBeUndefined()
  })

  it('homedir 抛错也降级成 undefined，不抛给调用方', () => {
    expect(resolveStateLocation({
      env: {},
      homedir: () => { throw new Error('no home') },
    })).toBeUndefined()
  })
})

describe('落点：★ 不能和网关的运行目录撞', () => {
  it('是 <home>/.wb2api/state.json（有点）', () => {
    expect(stateFilePath('C:\\home')).toBe(join('C:\\home', '.wb2api', 'state.json'))
    expect(STATE_DIR_NAME).toBe('.wb2api')
    expect(STATE_FILE_NAME).toBe('state.json')
  })

  it('🔴 与网关的 <home>/wb2api/ 是两个不同目录', () => {
    const ours = stateFilePath('C:\\home')
    const gateway = join('C:\\home', 'wb2api', 'state.json')
    expect(ours).not.toBe(gateway)
    // 逐段比较：`.wb2api` ≠ `wb2api`
    expect(STATE_DIR_NAME).not.toBe('wb2api')
  })
})

describe('readOffered（读：任何异常都当「没有记录」）', () => {
  it('文件不存在 ⇒ undefined', () => {
    expect(readOffered(join(tempDir(), '.wb2api', 'state.json'), 'workbuddy')).toBeUndefined()
  })

  it('JSON 坏 ⇒ undefined（不抛）', () => {
    const file = join(tempDir(), 'state.json')
    writeFileSync(file, '{ 这不是 JSON', 'utf8')
    expect(readOffered(file, 'workbuddy')).toBeUndefined()
  })

  it('顶层不是对象 / providers 不是对象 / 没有这个 provider / lastOffered 不是数组 ⇒ 全是 undefined', () => {
    const dir = tempDir()
    const cases: Array<[string, string]> = [
      ['顶层是数组', '[]'],
      ['顶层是 null', 'null'],
      ['providers 不是对象', '{"version":1,"providers":[]}'],
      ['没有这个 provider', '{"version":1,"providers":{"other":{"lastOffered":["x"]}}}'],
      ['provider 不是对象', '{"version":1,"providers":{"workbuddy":"x"}}'],
      ['lastOffered 不是数组', '{"version":1,"providers":{"workbuddy":{"lastOffered":"x"}}}'],
    ]
    for (const [label, text] of cases) {
      const file = join(dir, `${label}.json`)
      writeFileSync(file, text, 'utf8')
      expect(readOffered(file, 'workbuddy'), label).toBeUndefined()
    }
  })

  it('🔴「记录是空数组」与「没有记录」必须分得开', () => {
    const file = join(tempDir(), 'state.json')
    writeFileSync(file, '{"version":1,"providers":{"workbuddy":{"lastOffered":[]}}}', 'utf8')
    expect(readOffered(file, 'workbuddy')).toEqual([])
    expect(readOffered(file, 'workbuddy')).not.toBeUndefined()
  })

  it('去重、保持首次出现的顺序、丢掉非字符串与空串', () => {
    const file = join(tempDir(), 'state.json')
    writeFileSync(file, JSON.stringify({
      version: 1,
      providers: { workbuddy: { lastOffered: ['b', 'a', 'b', 7, null, '', 'cn:模型'] } },
    }), 'utf8')
    expect(readOffered(file, 'workbuddy')).toEqual(['b', 'a', 'cn:模型'])
  })

  it('readStateFile 读不到时给空对象（成员任意，不抛）', () => {
    expect(readStateFile(join(tempDir(), 'nope.json'))).toEqual({})
  })
})

describe('writeOffered（写：读-改-写 + 只动一个键）', () => {
  it('目录不存在时自动建；写出来是 2 空格缩进 + 末尾换行 + version', () => {
    const home = tempDir()
    const file = stateFilePath(home)
    writeOffered(file, 'workbuddy', ['a', 'b'])
    expect(existsSync(file)).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "version": 1')
    expect(JSON.parse(text)).toEqual({
      version: STATE_SCHEMA_VERSION,
      providers: { workbuddy: { lastOffered: ['a', 'b'] } },
    })
  })

  it('非 ASCII 的 id 按 utf8 落盘（能原样读回来）', () => {
    const file = stateFilePath(tempDir())
    writeOffered(file, 'workbuddy', ['cn:模型-甲'])
    expect(readFileSync(file, 'utf8')).toContain('cn:模型-甲')
    expect(readOffered(file, 'workbuddy')).toEqual(['cn:模型-甲'])
  })

  it('🔴 只改自己那个 provider：别的 provider 与别的顶层键都留着', () => {
    const file = stateFilePath(tempDir())
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({
      version: 1,
      activeAccountId: 'cn-1',
      providers: { other: { lastOffered: ['keep-me'] }, workbuddy: { lastOffered: ['old'] } },
    }, null, 2), 'utf8')
    writeOffered(file, 'workbuddy', ['new1', 'new2'])
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(parsed['activeAccountId']).toBe('cn-1')
    expect(parsed['providers']).toEqual({
      other: { lastOffered: ['keep-me'] },
      workbuddy: { lastOffered: ['new1', 'new2'] },
    })
  })

  it('文件坏掉时照写不误（当成空状态重建），不抛', () => {
    const file = stateFilePath(tempDir())
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'not json at all', 'utf8')
    expect(() => { writeOffered(file, 'workbuddy', ['a']) }).not.toThrow()
    expect(readOffered(file, 'workbuddy')).toEqual(['a'])
  })

  it('写入失败会抛（由调用方捕获并注明，绝不影响 provider 写入）', () => {
    // 把一个**文件**当成目录用 ⇒ mkdirSync 必然失败。
    const dir = tempDir()
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x', 'utf8')
    expect(() => { writeOffered(join(blocker, '.wb2api', 'state.json'), 'workbuddy', ['a']) }).toThrow()
  })

  it('normalizeIds 对非数组给空数组', () => {
    expect(normalizeIds(undefined)).toEqual([])
    expect(normalizeIds('x')).toEqual([])
    expect(normalizeIds(['a', 'a'])).toEqual(['a'])
  })
})

describe('openTombstone', () => {
  it('拿不到 home ⇒ undefined（不启用墓碑）', () => {
    expect(openTombstone({ providerName: 'workbuddy', profileHome: '', env: {}, homedir: () => undefined }))
      .toBeUndefined()
  })

  it('接好线之后：写进去能原样读回来', () => {
    const home = tempDir()
    const tombstone = openTombstone({ providerName: 'workbuddy', profileHome: home, env: {} })
    expect(tombstone).toBeDefined()
    if (tombstone === undefined) throw new Error('unreachable')
    expect(tombstone.source).toBe('profile')
    expect(tombstone.filePath).toBe(stateFilePath(home))
    expect(tombstone.read()).toBeUndefined()
    tombstone.write(['a', 'b'])
    expect(tombstone.read()).toEqual(['a', 'b'])
  })
})
