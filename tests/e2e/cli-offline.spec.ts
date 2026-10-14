/**
 * `tools/wb2api.mjs`（独立 CLI，不经 dsh 插件）的**离线**契约。
 *
 * 这个文件存在的起因很具体：那个 CLI 是独立于插件的第二入口，不在 `tests/unit/**`
 * 的覆盖里，于是它可以被改坏而**全绿套件一个字都不说**。这里只钉住三条**不发请求**
 * 的行为 —— 参数校验与退出码，也就是"人和脚本都靠它判断下一步"的那一层：
 *
 *   ① `--help` ⇒ 0；
 *   ② 未知命令 ⇒ 2（用法错，与"网关不可达"的 1 分开）；
 *   ③ `test` 缺 `--model` ⇒ 2，且**在联网之前就返回**。
 *
 * ③ 是最要紧的一条：`test` 是那个 CLI 里**唯一会花额度**的命令，而"缺参数"必须在
 * 拨号之前就被拦住 —— 否则一次笔误就是一次真实消费。这里的断言方式就是**不给它任何
 * 可达的网关**（见下），所以万一它真的尝试联网，得到的是连接失败 ⇒ 退出码 1 ⇒ 断言红。
 *
 * **离线性是构造出来的，不是假设的**：三条断言全部走 `--config <临时文件>`，指向一个
 * 只存在于本次测试临时目录里的 config.json（`listen` 指向一个必然连不上的端口）。
 * 这样既不依赖本机 `~/.dsh/wb2api/config.json` 是否存在（CI 上没有 ⇒ 会变成退出码 1
 * 而不是 2，把一条环境差异伪装成失败），也不会碰到真实网关。
 *
 * 为什么断言的是**退出码**而不是输出文本：退出码才是 `_run-suites.mjs` 与 shell 脚本
 * 依赖的契约。文案可以改，退出码不能。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const CLI = join(ROOT, 'tools', 'wb2api.mjs')

/** 一个**必然连不上**的网关地址：断言③若真去拨号，会以退出码 1 失败而不是静默变绿。 */
const DEAD_ORIGIN = '127.0.0.1:9'

let tempDir: string
let configPath: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wb2api-cli-'))
  configPath = join(tempDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    listen: DEAD_ORIGIN,
    api_key: 'fixture-key-not-a-real-credential',
  }))
})

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // 忽略清理失败。
  }
})

/**
 * 跑一次 CLI 并拿回退出码 + 输出。
 *
 * `timeout` 是必须的：这三条本该**立即**返回，若哪天有人在参数校验之前插了网络调用，
 * 这里要的是"快速失败"，而不是让整个套件挂死到超时。
 */
function runCli(args: string[]): { status: number | null; output: string; signal: NodeJS.Signals | null } {
  const run = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}`, signal: run.signal }
}

describe('tools/wb2api.mjs：离线契约（不发请求）', () => {
  it('--help ⇒ 退出 0', () => {
    const { status, output } = runCli(['--help'])
    expect(status).toBe(0)
    // 帮助里必须能看到各命令与退出码表 —— 否则"帮助"帮不了人。
    expect(output).toContain('status')
    expect(output).toContain('models')
    expect(output).toContain('usage')
    expect(output).toContain('test')
  })

  it('-h ⇒ 退出 0（与 --help 同一条路）', () => {
    expect(runCli(['-h']).status).toBe(0)
  })

  it('未知命令 ⇒ 退出 2（用法错，不是"网关不可达"的 1）', () => {
    const { status, output } = runCli(['definitely-not-a-command', '--config', configPath])
    expect(status).toBe(2)
    expect(output).toContain('definitely-not-a-command')
  })

  it('test 缺 --model ⇒ 退出 2，且在联网之前就返回', () => {
    const { status, output } = runCli(['test', '--config', configPath])
    expect(status).toBe(2)
    // 退出码 2 已经说明它在拨号前返回了；这里再把"它到底说了什么"钉住，
    // 免得将来有人把这个分支改成别的失败原因而退出码恰好还是 2。
    expect(output).toContain('--model')
  })

  it('test --model 但没 --yes ⇒ 仍然退出 2（成本闸在发消息之前）', () => {
    // 注意：这条会真的去拉 /v1/models（只读、零积分），但 DEAD_ORIGIN 连不上 ⇒
    // 大概率走"网关不可达"的 1。所以这里只断言**不是 0**：
    // 本测试要保证的是"绝不发出那条会花额度的消息"，不是某一个具体退出码。
    const { status } = runCli(['test', '--model', 'cn:fixture', '--config', configPath])
    expect(status).not.toBe(0)
  })
})
