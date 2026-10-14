/**
 * 插件自己的启动轨迹（`<DSH_HOME>/.wb2api/boot.log`）。
 *
 * 这一层的硬要求：
 *   ① **格式**：`<ISO8601 带毫秒带 Z>` + **两个空格** + 消息 + `\n`；
 *   ② **追加**：不清空、不轮转 —— 它要能证明「上一次启动发生过什么」；
 *   ③ **目录自动创建**：home 可能是刚建的、`state.json` 还没写过；
 *   ④ ★ **写不进去也绝不抛** —— 追踪绝不能成为启动失败的原因（本文件的重点）；
 *   ⑤ **home 拿不到 ⇒ 静默不写、也不抛**（被裁剪过的运行时 / 没有 home 的容器）。
 *
 * ⚠️ **本文件刻意不断言行数**。轨迹的锚点会随版本演化（dsh-trae 实测从文档里的
 * 「六行」涨到 9 行），断行数会让每加一个锚点就红一次，从而逼着人删断言。
 * 一律断「某个前缀在不在」。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BOOT_LOG_FILE_NAME,
  BOOT_TRACE_SEPARATOR,
  bootLogPath,
  resolveBootLogPath,
  trace,
  writeBootTrace,
} from '../../src/boot-trace.js'
import { STATE_DIR_NAME } from '../../src/plugin-state.js'

const temps: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb2api-trace-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/** 造一个「注定写不进去」的 home：boot.log 的位置被一个**目录**占着。 */
function blockedHome(): string {
  const home = tempDir()
  mkdirSync(join(home, STATE_DIR_NAME, BOOT_LOG_FILE_NAME), { recursive: true })
  return home
}

/** 按行读出轨迹（丢掉末尾空行）。 */
function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter(line => line !== '')
}

describe('落点：与 state.json **同目录**', () => {
  it('是 <home>/.wb2api/boot.log（有点）', () => {
    expect(bootLogPath('C:\\home')).toBe(join('C:\\home', '.wb2api', 'boot.log'))
    expect(BOOT_LOG_FILE_NAME).toBe('boot.log')
  })

  it('🔴 目录名与 state.json 用的是**同一个常量**，不会各自漂移', () => {
    const home = 'C:\\home'
    const state = join(home, STATE_DIR_NAME, 'state.json')
    expect(bootLogPath(home)).toBe(join(home, STATE_DIR_NAME, BOOT_LOG_FILE_NAME))
    expect(bootLogPath(home).replace(BOOT_LOG_FILE_NAME, 'state.json')).toBe(state)
  })

  it('🔴 与网关自己的运行目录 <home>/wb2api/ 是两个不同目录', () => {
    expect(bootLogPath('C:\\home')).not.toBe(join('C:\\home', STATE_DIR_NAME.replace('.', ''), BOOT_LOG_FILE_NAME))
  })

  it('home 是空白时给空串（而不是一个相对路径）', () => {
    expect(bootLogPath('')).toBe('')
    expect(bootLogPath('   ')).toBe('')
  })
})

describe('resolveBootLogPath（复用墓碑那套 home 解析）', () => {
  it('profileContext.home 优先', () => {
    expect(resolveBootLogPath({
      profileHome: 'C:\\temp\\home',
      env: { DSH_HOME: 'D:\\other' },
      homedir: () => 'C:\\Users\\nobody',
    })).toBe(join('C:\\temp\\home', '.wb2api', 'boot.log'))
  })

  it('没有 profileContext 时退到环境变量 DSH_HOME', () => {
    expect(resolveBootLogPath({ env: { DSH_HOME: 'D:\\iso\\home' }, homedir: () => 'C:\\Users\\nobody' }))
      .toBe(join('D:\\iso\\home', '.wb2api', 'boot.log'))
  })

  it('两个都没有时退到 ~/.dsh（DSH 自己的默认值）', () => {
    expect(resolveBootLogPath({ env: {}, homedir: () => 'C:\\Users\\rumil' }))
      .toBe(join('C:\\Users\\rumil', '.dsh', '.wb2api', 'boot.log'))
  })

  it('🔴 一条都拿不到 ⇒ undefined（静默不写），不抛', () => {
    expect(resolveBootLogPath({ profileHome: '', env: {}, homedir: () => undefined })).toBeUndefined()
    expect(resolveBootLogPath({ profileHome: '   ', env: { DSH_HOME: '  ' }, homedir: () => '' })).toBeUndefined()
  })

  it('homedir 抛错也降级成 undefined，不抛给调用方', () => {
    expect(resolveBootLogPath({ env: {}, homedir: () => { throw new Error('no home') } })).toBeUndefined()
  })
})

describe('格式（<ISO 时间戳>␣␣<消息>\\n，追加）', () => {
  it('写出来正好一行、格式对', () => {
    const home = tempDir()
    expect(writeBootTrace('apply: provider=workbuddy', { profileHome: home, env: {} })).toBe(true)
    const path = bootLogPath(home)
    const lines = readLines(path)
    expect(lines).toHaveLength(1)

    const [line] = lines
    if (line === undefined) throw new Error('unreachable')
    const [stamp, message] = line.split(BOOT_TRACE_SEPARATOR)
    expect(message).toBe('apply: provider=workbuddy')
    // 时间戳本身要是合法日期，且**原样**出现在行首（不是行尾、不是被引号包着）
    expect(line.startsWith(stamp ?? '')).toBe(true)
    expect(Number.isNaN(Date.parse(stamp ?? ''))).toBe(false)
  })

  it('时间戳是 ISO8601、带毫秒、带 Z', () => {
    const home = tempDir()
    writeBootTrace('x', { profileHome: home, env: {}, now: () => new Date('2026-10-14T13:33:26.740Z') })
    expect(readLines(bootLogPath(home))).toEqual(['2026-10-14T13:33:26.740Z  x'])
  })

  it('分隔符就是**两个空格**（一个空格会让解析歧义）', () => {
    expect(BOOT_TRACE_SEPARATOR).toBe('  ')
    const home = tempDir()
    writeBootTrace('msg', { profileHome: home, env: {}, now: () => new Date('2026-01-02T03:04:05.006Z') })
    const text = readFileSync(bootLogPath(home), 'utf8')
    expect(text).toBe('2026-01-02T03:04:05.006Z  msg\n')
    expect(text).not.toContain('Z msg') // 单个空格是错的
  })

  it('🔴 追加而不是覆盖：第二次调用不会抹掉第一次的', () => {
    const home = tempDir()
    writeBootTrace('第一行', { profileHome: home, env: {} })
    writeBootTrace('第二行', { profileHome: home, env: {} })
    const lines = readLines(bootLogPath(home))
    expect(lines.some(line => line.includes('第一行'))).toBe(true)
    expect(lines.some(line => line.includes('第二行'))).toBe(true)
    expect(lines).toHaveLength(2)
  })

  it('非 ASCII 按 utf8 落盘（能原样读回来）', () => {
    const home = tempDir()
    writeBootTrace('seed: present — 供应商已存在，未改动', { profileHome: home, env: {} })
    expect(readFileSync(bootLogPath(home), 'utf8')).toContain('供应商已存在，未改动')
  })

  it('★ 多行消息里每一行都以时间戳开头（解析器可以逐行 split）', () => {
    const home = tempDir()
    writeBootTrace('第一段\n第二段', { profileHome: home, env: {}, now: () => new Date('2026-01-02T03:04:05.006Z') })
    const lines = readLines(bootLogPath(home))
    expect(lines).toHaveLength(2)
    expect(lines[0]?.startsWith('2026-01-02T03:04:05.006Z')).toBe(true)
    // 第二行**没有**自己的时间戳 —— 所以约定是「一条 trace 一行」，这里只是把事实钉住。
    expect(lines[1]).toBe('第二段')
  })
})

describe('目录不存在 ⇒ 自动创建', () => {
  it('home 下连 .wb2api 都没有时也能写', () => {
    const home = tempDir()
    expect(existsSync(join(home, STATE_DIR_NAME))).toBe(false)
    expect(writeBootTrace('boot', { profileHome: home, env: {} })).toBe(true)
    expect(existsSync(join(home, STATE_DIR_NAME))).toBe(true)
    expect(readLines(bootLogPath(home))).toHaveLength(1)
  })

  it('home 本身也不存在时连它一起建（递归）', () => {
    const home = join(tempDir(), 'deep', 'nested', 'home')
    expect(existsSync(home)).toBe(false)
    expect(writeBootTrace('boot', { profileHome: home, env: {} })).toBe(true)
    expect(readLines(bootLogPath(home))).toHaveLength(1)
  })
})

describe('★ 失败策略：写不进去也绝不抛（追踪绝不能拖垮启动）', () => {
  it('🔴 boot.log 的位置被目录占着 ⇒ 返回 false，**不抛**', () => {
    const home = blockedHome()
    expect(() => { writeBootTrace('x', { profileHome: home, env: {} }) }).not.toThrow()
    expect(writeBootTrace('x', { profileHome: home, env: {} })).toBe(false)
  })

  it('🔴 trace() 这个生产入口在任何失败下都**没有返回值、也不抛**', () => {
    expect(() => {
      for (let i = 0; i < 3; i += 1) writeBootTrace(`boom ${i}`, { profileHome: blockedHome(), env: {} })
    }).not.toThrow()
  })

  it('🔴 trace() 真的会落到 DSH_HOME 下（并且失败时照样不抛）', () => {
    // 用进程环境变量把一个**临时 home** 指给 trace()：这样既覆盖了「生产入口确实在写」，
    // 又不会污染跑测试这台机器真正的 home。
    // ⚠️ 注意顺序：要**先把 DSH_HOME 指到临时目录**，再调 trace() —— 反过来就会在
    // 真实 home 里留下一个 boot.log（这条注释是踩过之后补的）。
    const home = tempDir()
    const previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = home
    try {
      expect(trace('apply: 生产入口')).toBeUndefined() // 没有返回值
      expect(readFileSync(bootLogPath(home), 'utf8')).toContain('apply: 生产入口')
      trace('再来一条')
      expect(readLines(bootLogPath(home))).toHaveLength(2)
    } finally {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }
  })

  it('🔴 home 拿不到 ⇒ 静默不写、不抛、也不留下任何文件', () => {
    const before = process.cwd()
    expect(() => { writeBootTrace('x', { env: {}, homedir: () => undefined }) }).not.toThrow()
    expect(writeBootTrace('x', { env: {}, homedir: () => undefined })).toBe(false)
    expect(process.cwd()).toBe(before) // 没在 CWD 里造出相对路径的 boot.log
  })

  it('🔴 路径推导本身抛错时也被吞掉（返回 false）', () => {
    expect(writeBootTrace('x', {
      resolvePath: () => { throw new Error('resolver exploded') },
    })).toBe(false)
  })

  it('🔴 mkdirSync 失败（父路径是文件）⇒ 返回 false，不抛', () => {
    const dir = tempDir()
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x', 'utf8')
    expect(writeBootTrace('x', { profileHome: blocker, env: {} })).toBe(false)
  })
})
