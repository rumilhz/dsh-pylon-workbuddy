import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { GatewaySupervisor } from '../../src/gateway-supervisor.js'
import { AccountStore } from '../../src/accounts.js'
import { resolveConfig, type GatewayPluginConfig } from '../../src/config.js'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * 本文件**所有**用例共用的配置工厂：把单次探活预算抬到与「机器忙不忙」无关的量级。
 *
 * ## 为什么非要有它（2026-10-15 实测，不是推测）
 *
 * `healthTimeoutSeconds` 的默认值 **3 秒**是**产品**对「一次探活往返」的耐心。
 * 而这条测试文件里凡是打真 loopback 服务的断言，成败都会挂到那个预算上：
 * 探活超时（`AbortSignal.timeout`）时 `probe()` 走的是 catch 分支 —— 于是
 *
 *   · `rejects.toThrow(/端口可能被其他程序占用/)` 变成「期望拒绝，实际 resolve」；
 *   · `expect(health?.healthy).toBe(0)` 变成 `expected undefined to be +0`。
 *
 * 机器一忙（16 核上 15 个 vitest worker、CI runner 抖动、杀软过滤 loopback …），
 * 一次往返就可能超过 3 秒 ⇒ **假红**。实测：给进程装上 3.2 秒的 fetch 停顿注入器
 * （`tools/_stall-fetch.cjs`）后，`-t 503` 的三条用例 **10/10 次全红**，报错正是
 * `promise resolved "undefined" instead of rejecting`；本机不带注入器时 15 次全套 0 红
 * —— 也就是说这条红只在「恰好停顿」时出现，肉眼永远抓不到。
 *
 * 这些用例考的是「**拿到响应之后**怎么判别」（503 响应体是不是本网关 / 2xx 是不是 JSON），
 * 不该由「多久算慢」决定成败。所以统一把预算抬到 30 秒：**断言一个字没动**，
 * 只是让「慢」不再伪装成「没人听」。
 *
 * ★ 预算边界本身**另有专门用例钉住**（见 `describe('探活的三态与预算边界')`）：
 * 那里用**可控的慢网关 + 小预算**确定性地断言边界语义，不依赖机器负载。
 */
const TEST_HEALTH_BUDGET_SECONDS = 30
function testConfig(raw: Partial<GatewayPluginConfig> = {}): GatewayPluginConfig {
  return resolveConfig({ healthTimeoutSeconds: TEST_HEALTH_BUDGET_SECONDS, ...raw })
}

/** 数一个目录里的 `*.json`（目录不存在 ⇒ 0）—— 与 `countAuthFiles()` 的容错口径一致。 */
function countJsonFiles(dir: string): number {
  return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.json')).length : 0
}

/**
 * 在「临时改 `DSH_HOME`」的作用域里跑一段断言，退出时无条件还原。
 *
 * 与 `dsh-home.spec.ts` 里那个同名助手是同一形态（这里没有共享的测试助手模块，
 * 复制 9 行比新开一个模块更小的改动；两处都改的时候记得一起改）。
 *
 * 为什么非要它：`countAuthFiles()` 的兜底基准是 `<DSH home>/wb2api`，
 * 而 `DSH_HOME` 未设时那就是**活体** `~/.dsh/wb2api` —— 一个属于开发机的目录。
 * 断言若直接读它，就变成"这台机器上恰好有 1 个凭证"的假绿（2026-10-15 实测）。
 */
async function withDshHome(value: string | undefined, body: () => void | Promise<void>): Promise<void> {
  const previous = process.env['DSH_HOME']
  try {
    if (value === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = value
    await body()
  } finally {
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
  }
}

/** 起一个真正的 HTTP 服务当假网关，让探活走完整网络路径。 */
async function startFakeGateway(handler: (path: string) => { status: number; body: string; delayMs?: number }): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const result = handler(request.url ?? '/')
    // 客户端在预算到点后会 abort ⇒ 这里的 writeHead/end 可能落在已销毁的 socket 上，
    // 那会在 response 上抛 'error'（未监听就是未捕获异常）。吞掉它：
    // 这些用例考的正是「应答得太晚」，不是「写坏了的 socket 怎么办」。
    response.on('error', () => {})
    const send = (): void => {
      response.writeHead(result.status, { 'content-type': 'application/json' })
      response.end(result.body)
    }
    if (result.delayMs !== undefined && result.delayMs > 0) setTimeout(send, result.delayMs)
    else send()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

/** 构造一个只记录调用的假 subprocess 服务。 */
function makeSubprocess(behavior: { exitImmediately?: boolean } = {}): {
  runtime: SubprocessRuntime
  spawns: Array<{ argv: readonly string[]; cwd: string; env: NodeJS.ProcessEnv | undefined }>
  terminateCalls: () => number
} {
  const spawns: Array<{ argv: readonly string[]; cwd: string; env: NodeJS.ProcessEnv | undefined }> = []
  let terminated = 0
  const runtime = {
    resolveExecutable: async (command: string) => {
      throw new Error(`not found: ${command}`)
    },
    terminalEnvironment: async () => ({ platform: 'windows' as const }),
    spawn: (spec: { argv: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv }) => {
      spawns.push({ argv: spec.argv, cwd: spec.cwd, env: spec.env })
      let resolveDone: (value: { exitCode: number | null; signal: null }) => void = () => {}
      const done = new Promise<{ exitCode: number | null; signal: null }>(resolve => { resolveDone = resolve })
      if (behavior.exitImmediately === true) queueMicrotask(() => resolveDone({ exitCode: 1, signal: null }))
      const handle = {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: { stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
        done,
        terminate: () => { terminated += 1; resolveDone({ exitCode: 0, signal: null }) },
        waitForExit: async () => true,
      } as unknown as SubprocessHandle
      return handle
    },
    spawnTerminal: async () => { throw new Error('unused') },
  } as unknown as SubprocessRuntime
  return { runtime, spawns, terminateCalls: () => terminated }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {})
})

describe('GatewaySupervisor.probe', () => {
  it('解析 /healthz 的 healthy / total / realm_servable', async () => {
    const gateway = await startFakeGateway(() => ({
      status: 200,
      body: JSON.stringify({ healthy: 1, total: 2, service: 'workbuddy2api', realm_servable: { cn: true, global: false } }),
    }))
    cleanups.push(gateway.close)
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: `http://127.0.0.1:${gateway.port}/v1` }),
      subprocess: runtime,
      logger: silentLogger,
    })
    const outcome = await supervisor.probe()
    expect(outcome.kind).toBe('ok')
    const health = outcome.kind === 'ok' ? outcome.report : undefined
    expect(health?.healthy).toBe(1)
    expect(health?.total).toBe(2)
    expect(health?.service).toBe('workbuddy2api')
    expect(health?.realmServable).toEqual({ cn: true, global: false })
  })

  it('端口无监听 ⇒ `no-listener`（不是错误、也不是「不可达」）', async () => {
    const { runtime } = makeSubprocess()
    // 用一个必然空闲的高端口。
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: 'http://127.0.0.1:59999/v1' }),
      subprocess: runtime,
      logger: silentLogger,
    })
    expect(await supervisor.probe()).toEqual({ kind: 'no-listener' })
  })

  it('端口被非网关程序占用时抛明确错误（而非静默失败）', async () => {
    const other = await startFakeGateway(() => ({ status: 404, body: 'nope' }))
    cleanups.push(other.close)
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: `http://127.0.0.1:${other.port}/v1` }),
      subprocess: runtime,
      logger: silentLogger,
    })
    await expect(supervisor.probe()).rejects.toThrow(/端口可能被其他程序占用/)
  })

  it('/healthz 返回非 JSON 时同样判定为端口被占用', async () => {
    const other = await startFakeGateway(() => ({ status: 200, body: '<html>hello</html>' }))
    cleanups.push(other.close)
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: `http://127.0.0.1:${other.port}/v1` }),
      subprocess: runtime,
      logger: silentLogger,
    })
    await expect(supervisor.probe()).rejects.toThrow(/端口可能被其他程序占用/)
  })

  /**
   * ★ 这条钉住的是一个**实测到的形态**：网关没有可用账号时 `/healthz` 返回 503
   *   （仓库自己的 `docs/handoff-20260915-gateway-plugin.md:268` 记着这件事，
   *   2026-10-15 的从零验证逐字抓到 `HTTP 503 {"healthy":0,…,"service":"workbuddy2api",…}`）。
   *
   *   过去它被当成「端口被别的程序占用」，于是：自动启动白等满 30s 预算后报一条
   *   **假的**「FAILED — /healthz 未就绪」，而网关其实正在跑、只是没账号。
   *
   * ★ 2026-10-15 补记：这条用例曾**偶发红**（15 次全套里 2 次），根因与 503 无关 ——
   *   只要那次 loopback 往返超过 `healthTimeoutSeconds=3`，旧 `probe()` 就会把
   *   「超时」当成「端口无监听」返回 undefined，于是这里的 `health?.healthy` 是
   *   undefined。现在 ①探活的三态把超时与「没人听」分开了（见下面那个 describe），
   *   ②本文件统一用 `testConfig()` 的 30 秒预算，断言一个字没动。
   */
  it('🔴 /healthz 返回 503（网关在跑但没有账号）⇒ 照常给出 healthy/total，不抛错', async () => {
    const gateway = await startFakeGateway(() => ({
      status: 503,
      body: JSON.stringify({ healthy: 0, total: 0, service: 'workbuddy2api', realm_servable: { cn: false, global: false } }),
    }))
    cleanups.push(gateway.close)
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: `http://127.0.0.1:${gateway.port}/v1` }),
      subprocess: runtime,
      logger: silentLogger,
    })
    const outcome = await supervisor.probe()
    expect(outcome.kind).toBe('ok')
    const health = outcome.kind === 'ok' ? outcome.report : undefined
    expect(health?.healthy).toBe(0)
    expect(health?.total).toBe(0)
    expect(health?.service).toBe('workbuddy2api')
    expect(health?.realmServable).toEqual({ cn: false, global: false })
  })

  it('503 但响应体不是本网关（别的服务的 JSON / 非 JSON）⇒ 仍然抛「端口被占用」', async () => {
    const cases = [
      JSON.stringify({ service: 'something-else', healthy: 0, total: 0 }),
      JSON.stringify({ status: 'unavailable' }),
      '<html>503</html>',
    ]
    for (const body of cases) {
      const other = await startFakeGateway(() => ({ status: 503, body }))
      cleanups.push(other.close)
      const { runtime } = makeSubprocess()
      const supervisor = new GatewaySupervisor({
        config: testConfig({ baseURL: `http://127.0.0.1:${other.port}/v1` }),
        subprocess: runtime,
        logger: silentLogger,
      })
      await expect(supervisor.probe()).rejects.toThrow(/端口可能被其他程序占用/)
    }
  })

  it('别的非 2xx（如 500）即便长得像本网关也不认 —— 只认 503 这条「无账号」信号', async () => {
    const other = await startFakeGateway(() => ({
      status: 500,
      body: JSON.stringify({ healthy: 0, total: 0, service: 'workbuddy2api' }),
    }))
    cleanups.push(other.close)
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: `http://127.0.0.1:${other.port}/v1` }),
      subprocess: runtime,
      logger: silentLogger,
    })
    await expect(supervisor.probe()).rejects.toThrow(/端口可能被其他程序占用/)
  })
})

/**
 * 探活的三态与「预算边界」：**唯一**由负载无关的确定性构造来钉的地方。
 *
 * ## 它钉住的是哪一次事故（2026-10-15，确定性复现）
 *
 * 旧 `probe()` 把**任何** fetch 异常都返回 `undefined`（= 文档里的「端口无监听」）：
 *
 * · 端口上**有**服务、只是这一次没在预算内回答 ⇒ 被当成「端口空闲」⇒ `start()`
 *   又 `spawn` 一个子进程 ⇒ 同端口 bind 失败 ⇒「进程意外退出」+ 退避重启 ×N，
 *   而网关其实在跑；
 * · `statusWithHealth()` 对在跑的网关报 `stopped`；
 * · `baseURL` 写错（fetch 抛 `TypeError`）也被算成「拒连」（`isConnectionRefused()`
 *   里那条 `TypeError && !cause.code`）。
 *
 * 这里用**可控的慢网关**（`delayMs`）而不是「机器恰好很忙」来制造边界：
 * 「应答比预算晚」是**确定**的，于是断言可以精确到语义（`unreachable` + 原因），
 * 而不是靠运气。
 */
describe('GatewaySupervisor.probe 的三态与预算边界（确定性）', () => {
  it('🔴 有监听、但应答比探活预算晚 ⇒ `unreachable`（带超时原因），**不是** `no-listener`', async () => {
    const gateway = await startFakeGateway(() => ({
      status: 200,
      body: JSON.stringify({ healthy: 1, total: 1 }),
      delayMs: 2000,
    }))
    cleanups.push(gateway.close)
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      // 1 秒预算 + 2 秒才应答：abort 先到点（两个定时器的到期顺序是确定的）。
      config: testConfig({ baseURL: `http://127.0.0.1:${gateway.port}/v1`, healthTimeoutSeconds: 1 }),
      subprocess: runtime,
      logger: silentLogger,
    })
    const outcome = await supervisor.probe()
    expect(outcome.kind).toBe('unreachable')
    // ★ 这一条就是那次误判本身：以前这里拿到的是 undefined，与"端口没人听"不可区分。
    expect(outcome.kind).not.toBe('no-listener')
    if (outcome.kind === 'unreachable') {
      expect(outcome.reason).toContain('/healthz')
      expect(outcome.reason).toContain('没有响应')
      expect(outcome.reason).toContain('1000ms')
    }
  })

  it('🔴 端口上有监听者（只是不回答）⇒ `start()` **不 spawn**，并给出明确原因', async () => {
    const gateway = await startFakeGateway(() => ({
      status: 200,
      body: JSON.stringify({ healthy: 1, total: 1 }),
      delayMs: 2000,
    }))
    cleanups.push(gateway.close)
    const binary = join(mkdtempSync(join(tmpdir(), 'wb2api-')), 'wb2a-server.exe')
    writeFileSync(binary, '')
    const { runtime, spawns } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({
        baseURL: `http://127.0.0.1:${gateway.port}/v1`,
        binaryPath: binary,
        healthTimeoutSeconds: 1,
      }),
      subprocess: runtime,
      logger: silentLogger,
    })
    // probeDecision 会重试 3 次（每次 1 秒 + 250ms 间隔）⇒ 这条用例需要更宽的用例上限。
    await expect(supervisor.start()).rejects.toThrow(/本次\*\*不\*\*自动拉起新进程/)
    expect(spawns).toHaveLength(0)
    const status = supervisor.status()
    expect(status.state).toBe('failed')
    // 类别要能支撑「指引分病因」：这是「端口上有服务」那一类，不是「没装/没登录」。
    expect(status.lastFailure).toBe('port-unresponsive')
    expect(status.lastError).toContain('没有响应')
  }, 20_000)

  it('端口确实没人听 ⇒ 照常 spawn（「该拉起就拉起」不许被上面那条误伤）', async () => {
    const binary = join(mkdtempSync(join(tmpdir(), 'wb2api-')), 'wb2a-server.exe')
    writeFileSync(binary, '')
    // 假进程立刻退出，让 waitForHealth 尽快收敛（否则要走满就绪轮询预算）。
    const { runtime, spawns } = makeSubprocess({ exitImmediately: true })
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: 'http://127.0.0.1:59993/v1', binaryPath: binary }),
      subprocess: runtime,
      logger: silentLogger,
    })
    const status = await supervisor.start()
    expect(spawns).toHaveLength(1)
    expect(status.state).toBe('failed')
    expect(status.lastError).toContain('意外退出')
  })

  it('🔴 baseURL 写错（fetch 抛 TypeError）⇒ 是 `unreachable`，不是「端口无监听」', async () => {
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: 'not-a-url', healthTimeoutSeconds: 1 }),
      subprocess: runtime,
      logger: silentLogger,
    })
    const outcome = await supervisor.probe()
    // 旧实现：`isConnectionRefused()` 里 `error.name === 'TypeError' && cause.code === undefined`
    // 一条把「URL 解析不了」也算成拒连 ⇒ 返回 undefined ⇒ 插件去拉本地网关，
    // 再把「配置写错」记成「30 秒内未就绪」。
    expect(outcome.kind).toBe('unreachable')
    if (outcome.kind === 'unreachable') expect(outcome.reason).toContain('请求失败')
  })

  it('网关在跑但这次探活没拿到响应 ⇒ `statusWithHealth()` 带上原因（不再静默）', async () => {
    const gateway = await startFakeGateway(() => ({
      status: 200,
      body: JSON.stringify({ healthy: 1, total: 1 }),
      delayMs: 2000,
    }))
    cleanups.push(gateway.close)
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: `http://127.0.0.1:${gateway.port}/v1`, healthTimeoutSeconds: 1 }),
      subprocess: runtime,
      logger: silentLogger,
    })
    const status = await supervisor.statusWithHealth()
    // 旧实现这里什么都不说（快照里既没 health 也没 lastError），
    // 于是「网关在跑、只是这次超时」与「端口上没人听」在 /wb2api-status 里长得一样。
    expect(status.lastError).toContain('探活未拿到响应')
    expect(status.lastError).toContain('没有响应')
  })
})

describe('GatewaySupervisor.start', () => {
  it('已有健康网关时直接复用，不重复 spawn', async () => {
    const gateway = await startFakeGateway(() => ({ status: 200, body: JSON.stringify({ healthy: 1, total: 1 }) }))
    cleanups.push(gateway.close)
    const { runtime, spawns } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: `http://127.0.0.1:${gateway.port}/v1` }),
      subprocess: runtime,
      logger: silentLogger,
    })
    const status = await supervisor.start()
    expect(status.state).toBe('external')
    expect(spawns).toHaveLength(0)
  })

  it('binaryPath 不存在时报错并指出配置项', async () => {
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: 'http://127.0.0.1:59998/v1', binaryPath: 'D:/nope/missing.exe' }),
      subprocess: runtime,
      logger: silentLogger,
    })
    await expect(supervisor.start()).rejects.toThrow(/binaryPath 不存在/)
  })

  it('spawn 后把显式 env 与工作目录传给子进程（子进程环境被 dsh 清洗）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb2api-'))
    const binary = join(dir, 'wb2a-server.exe')
    writeFileSync(binary, '')
    // exitImmediately：假进程立刻退出，让 waitForHealth 尽快收敛，
    // 否则会走满 30s 的就绪轮询预算。
    const { runtime, spawns } = makeSubprocess({ exitImmediately: true })
    const supervisor = new GatewaySupervisor({
      config: testConfig({
        baseURL: 'http://127.0.0.1:59997/v1',
        binaryPath: binary,
        workingDir: dir,
        env: { WB2API_LOG: 'debug' },
      }),
      subprocess: runtime,
      logger: silentLogger,
    })
    const status = await supervisor.start()
    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.argv[0]).toBe(binary)
    expect(spawns[0]?.cwd).toBe(dir)
    // env 必须显式传入：dsh 会把凭据形名称与 DSH_* 从子进程环境里剥离。
    expect(spawns[0]?.env).toEqual({ WB2API_LOG: 'debug' })
    expect(status.state).toBe('failed')
    expect(status.lastError).toContain('意外退出')
  })

  it('工作目录缺省时回退到 repoPath', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb2api-'))
    const binary = join(dir, 'wb2a-server.exe')
    writeFileSync(binary, '')
    const { runtime, spawns } = makeSubprocess({ exitImmediately: true })
    const supervisor = new GatewaySupervisor({
      config: testConfig({
        baseURL: 'http://127.0.0.1:59996/v1',
        binaryPath: binary,
        repoPath: dir,
      }),
      subprocess: runtime,
      logger: silentLogger,
    })
    await supervisor.start()
    expect(spawns[0]?.cwd).toBe(dir)
  })
})

describe('GatewaySupervisor.countAuthFiles', () => {
  it('统计 auths 下的 .json 文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb2api-'))
    mkdirSync(join(dir, 'auths'))
    writeFileSync(join(dir, 'auths', 'a.json'), '{}')
    writeFileSync(join(dir, 'auths', 'b.json'), '{}')
    writeFileSync(join(dir, 'auths', 'readme.txt'), 'x')
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({ repoPath: dir }),
      subprocess: runtime,
      logger: silentLogger,
    })
    expect(supervisor.countAuthFiles()).toBe(2)
  })

  /**
   * ★ 2026-10-15 修掉一条**永远不可能失败**的断言，本条把它换成真契约。
   *
   * 旧版（标题「未配置 repoPath 或无 auths 目录时返回 0」）断言的是
   * `Number.isInteger(count) && count >= 0` —— 只要函数不抛错、不返回负数就绿，
   * 与"到底数了几个"无关。而本机 `~/.dsh/wb2api/auths` 有 **1** 个凭证文件
   * （实测：`countAuthFiles()` 在无 repoPath 时返回 **1**），
   * 于是"标题说 0、实测是 1"这件事被那条断言完整地掩盖了。
   *
   * ## 这条测试的契约是什么
   *
   * `countAuthFiles()` 数的是**网关真正会读的那个 `auths/`** —— 也就是
   * {@link AccountStore.authDir} 指的那个目录（基准顺序与 `resolveWorkingDir()` 同源：
   * `workingDir` → `repoPath` → `<DSH home>/wb2api`（**且那里有 `config.json` 时**）
   * → 当前工作目录）。
   *
   * 「返回 0」只是"那个目录恰好是空的"的**结果**，不是任何一条分支的契约。
   *
   * ## 为什么改成这样就能失败（旧版不能）
   *
   * 用 `DSH_HOME` 指一个**隔离 home**：基准跟着 home 走 ⇒ 结果由我们造的文件决定。
   * 若哪天有人把基准改回"cwd"或"活体 `~/.dsh/wb2api`"，下面的数字立刻对不上：
   * 本机活体那份有 1 个凭证，空隔离 home 那一条会变成 1 而不是 0。
   *
   * ★ 2026-10-15（B）补记：那个「基准是插件运行目录」的回落**以 `config.json` 存在为前提**，
   * 因为同样的判据也在 `AccountStore.authDir()` 里（它是"网关会不会在这个目录里跑"的判据）。
   * 少了它，登录会写进插件运行目录、而网关在别处跑 —— 那种不一致**不报错**。
   * 现实中这两样东西由 `/wb2api-setup` 的 `ensureRuntimeDir()` 一起创建（`auths/` 与
   * `config.json` 同生共死），所以下面的夹具按真实形态带上 `config.json`；
   * 「有 auths/、没 config.json」这个**现实中不存在**的状态单列在 ②，钉的正是两处口径一致。
   */
  it('🔴 未配置 workingDir/repoPath ⇒ 基准是插件运行目录（<DSH home>/wb2api），与 cwd、活体 home 无关', async () => {
    const { runtime } = makeSubprocess()
    // 显式写空：默认值将来若变，这条测试的意图不应该跟着漂。
    const noPaths = { repoPath: '', workingDir: '' }

    // ① 隔离 home 里放 2 个 .json + 1 个 .txt ⇒ 只数 .json。
    //    带上 config.json（真实形态：/wb2api-setup 建运行目录时一并写），
    //    否则「插件运行目录」这一档根本不参与判定（见 ②）。
    const home = mkdtempSync(join(tmpdir(), 'wb2api-home-'))
    mkdirSync(join(home, 'wb2api', 'auths'), { recursive: true })
    writeFileSync(join(home, 'wb2api', 'config.json'), JSON.stringify({ auth_dir: './auths' }))
    writeFileSync(join(home, 'wb2api', 'auths', 'a.json'), '{}')
    writeFileSync(join(home, 'wb2api', 'auths', 'b.json'), '{}')
    writeFileSync(join(home, 'wb2api', 'auths', 'readme.txt'), 'x')
    await withDshHome(home, () => {
      expect(new GatewaySupervisor({ config: testConfig(noPaths), subprocess: runtime, logger: silentLogger }).countAuthFiles()).toBe(2)
    })

    // ② 隔离 home 里**有 auths/、没有 config.json** ⇒ 基准**不**是它，而是与
    //    `AccountStore.authDir()` 相同的那一个（现实中不存在这个状态：`/wb2api-setup`
    //    建目录时 `auths/` 与 `config.json` 是一起写的）。判据写成"两处口径必须一致"
    //    而不是写死某个数字 —— 只断言"数字相等"就能同时钉住"不许再各数各的"。
    //    ★ 旧实现这里会数插件运行目录（2），而 authDir() 数的是 cwd ⇒ 直接红。
    const noConfigHome = mkdtempSync(join(tmpdir(), 'wb2api-noconfig-'))
    mkdirSync(join(noConfigHome, 'wb2api', 'auths'), { recursive: true })
    writeFileSync(join(noConfigHome, 'wb2api', 'auths', 'a.json'), '{}')
    writeFileSync(join(noConfigHome, 'wb2api', 'auths', 'b.json'), '{}')
    await withDshHome(noConfigHome, () => {
      const config = testConfig(noPaths)
      const fromStore = countJsonFiles(new AccountStore({ config, logger: silentLogger }).authDir())
      expect(new GatewaySupervisor({ config, subprocess: runtime, logger: silentLogger }).countAuthFiles()).toBe(fromStore)
    })

    // ③ 隔离 home 完全空（连 wb2api/ 都没有）⇒ 0。
    //    ★ 这条是关键：本机活体 `~/.dsh/wb2api/auths` 里有 1 个凭证文件，
    //    基准若偷偷落回活体，这里就会是 1 ⇒ 红。（旧断言此时照样绿。）
    const emptyHome = mkdtempSync(join(tmpdir(), 'wb2api-nohome-'))
    await withDshHome(emptyHome, () => {
      expect(new GatewaySupervisor({ config: testConfig(noPaths), subprocess: runtime, logger: silentLogger }).countAuthFiles()).toBe(0)
    })

    // ④ 「有 repoPath 但 auths/ 不存在」⇒ 0（旧标题里那一半是真的，留着）。
    const bare = mkdtempSync(join(tmpdir(), 'wb2api-bare-'))
    expect(new GatewaySupervisor({ config: testConfig({ repoPath: bare }), subprocess: runtime, logger: silentLogger }).countAuthFiles()).toBe(0)
  })

  /**
   * ★ 2026-10-15（B）：`countAuthFiles()` 与 `AccountStore.authDir()` 曾经是**两套口径**。
   *
   * 旧实现固定拼 `<基准>/auths`，**不读**网关 `config.json` 的 `auth_dir`；而登录写入
   * 与账号切换用的是 `AccountStore.authDir()`，它会读 ⇒ 用户把 `auth_dir` 改成
   * `./creds` 之后，这个数字**恒为 0**。它出现的场合全是解释「为什么没有可用账号」
   * 的提示文案 —— 等于把人指向一个空的默认目录去排查。
   *
   * 判据刻意写成「两个消费者必须数**同一个**目录」（而不是写死 2）：
   * 口径一致才是契约，具体数字只是这次夹具的结果。夹具里特地在**默认目录**留了
   * 一个过期的 `stale.json`：口径写错时数出来是 1，写对了才是 2。
   */
  it('🔴 auth_dir 改过之后 ⇒ 数的是网关真正读的那个目录（与 AccountStore.authDir() 同口径）', async () => {
    const { runtime } = makeSubprocess()
    const home = mkdtempSync(join(tmpdir(), 'wb2api-home-'))
    const runtimeDir = join(home, 'wb2api')
    mkdirSync(join(runtimeDir, 'auths'), { recursive: true })
    mkdirSync(join(runtimeDir, 'creds'), { recursive: true })
    writeFileSync(join(runtimeDir, 'auths', 'stale.json'), '{}')
    writeFileSync(join(runtimeDir, 'config.json'), JSON.stringify({ auth_dir: './creds' }))
    writeFileSync(join(runtimeDir, 'creds', 'workbuddy-a.json'), '{}')
    writeFileSync(join(runtimeDir, 'creds', 'workbuddy-b.json'), '{}')

    await withDshHome(home, () => {
      const config = testConfig({ repoPath: '', workingDir: '' })
      const supervisor = new GatewaySupervisor({ config, subprocess: runtime, logger: silentLogger })
      const store = new AccountStore({ config, logger: silentLogger })
      const fromStore = countJsonFiles(store.authDir())
      expect(store.authDir()).toBe(join(runtimeDir, 'creds'))
      expect(fromStore).toBe(2)
      // 同一个目录才是契约：诊断数字与"登录写哪儿"不许各数各的。
      expect(supervisor.countAuthFiles()).toBe(fromStore)
    })
  })

  it('workingDir 优先于 repoPath（与网关真实 cwd 同源）', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wb2api-repo-'))
    const work = mkdtempSync(join(tmpdir(), 'wb2api-work-'))
    mkdirSync(join(repo, 'auths'))
    mkdirSync(join(work, 'auths'))
    writeFileSync(join(repo, 'auths', 'repo.json'), '{}')
    writeFileSync(join(work, 'auths', 'w1.json'), '{}')
    writeFileSync(join(work, 'auths', 'w2.json'), '{}')
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({ repoPath: repo, workingDir: work }),
      subprocess: runtime,
      logger: silentLogger,
    })
    // 数的是网关真正会读的那个目录，不是 repoPath。
    expect(supervisor.countAuthFiles()).toBe(2)
  })
})

describe('GatewaySupervisor 生命周期', () => {
  it('stop 会终止受管进程', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb2api-'))
    const binary = join(dir, 'wb2a-server.exe')
    writeFileSync(binary, '')
    const { runtime, terminateCalls, spawns } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: 'http://127.0.0.1:59995/v1', binaryPath: binary }),
      subprocess: runtime,
      logger: silentLogger,
    })
    // 直接 start 会在探活轮询里等待；用 dispose 验证 terminate 被调用。
    void supervisor.start()
    // ★ 不用固定 sleep：机器一忙，这一轮 start() 可能还没走到 spawn() 就被下面的
    //   dispose() 作废（代际 ++ ⇒ bringUp 在检查点放弃）⇒ terminate 一次都不会被调用，
    //   而那是**假红**（"stop 没杀掉进程" 与 "进程还没起来" 长得一样）。
    //   等到真 spawn 出来再收 —— 判据从"等了 50ms"换成"spawn 发生了"。
    const deadline = Date.now() + 10_000
    while (spawns.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await supervisor.dispose()
    expect(spawns).toHaveLength(1)
    expect(terminateCalls()).toBeGreaterThan(0)
  })

  it('stop 后再 status 为 stopped', async () => {
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: 'http://127.0.0.1:59994/v1' }),
      subprocess: runtime,
      logger: silentLogger,
    })
    await supervisor.stop()
    expect(supervisor.status().state).toBe('stopped')
  })

  it('statusWithHealth 在网关可达时报告 health', async () => {
    const gateway = await startFakeGateway(() => ({ status: 200, body: JSON.stringify({ healthy: 3, total: 3 }) }))
    cleanups.push(gateway.close)
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: `http://127.0.0.1:${gateway.port}/v1` }),
      subprocess: runtime,
      logger: silentLogger,
    })
    const status = await supervisor.statusWithHealth()
    expect(status.health?.healthy).toBe(3)
    expect(status.port).toBe(gateway.port)
  })

  it('复用外部网关（external）时 start() 也带回 health', async () => {
    // 回归：start() 内部已经探活拿到 health（用来决定 running/unhealthy），
    // 若返回值里丢掉它，调用方就只能看到「运行中」而看不到账号数 ——
    // 表现为「插件启动时 setup 消息没有账号信息」。
    const gateway = await startFakeGateway(() => ({
      status: 200,
      body: JSON.stringify({ healthy: 2, total: 3, realm_servable: { cn: true, global: false } }),
    }))
    cleanups.push(gateway.close)
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: `http://127.0.0.1:${gateway.port}/v1` }),
      subprocess: runtime,
      logger: silentLogger,
    })

    const status = await supervisor.start()
    expect(status.state).toBe('external')
    expect(status.health?.healthy).toBe(2)
    expect(status.health?.total).toBe(3)
  })

  it('启动进行中再次 start() 会等同一轮，而不是回一个没有账号信息的空壳', async () => {
    // 真实场景：dsh 启动时 autoStart 正在拉起网关，用户紧接着执行 /wb2api-setup。
    // 第二个调用若走「handle 已存在」的早返回，拿到的快照没有 health。
    const gateway = await startFakeGateway(() => ({
      status: 200,
      body: JSON.stringify({ healthy: 5, total: 5 }),
    }))
    cleanups.push(gateway.close)
    const { runtime, spawns } = makeSubprocess()
    const binary = join(mkdtempSync(join(tmpdir(), 'wb2api-')), 'wb2a-server.exe')
    writeFileSync(binary, '')
    const supervisor = new GatewaySupervisor({
      config: testConfig({ baseURL: `http://127.0.0.1:${gateway.port}/v1`, binaryPath: binary }),
      subprocess: runtime,
      logger: silentLogger,
    })

    // 第一个调用会因为端口上已有健康网关而立刻复用；关键是两个调用拿到同一结果。
    const [first, second] = await Promise.all([supervisor.start(), supervisor.start()])
    expect(first.health?.healthy).toBe(5)
    expect(second.health?.healthy).toBe(5)
    // 且不该重复 spawn 出第二个网关进程。
    expect(spawns).toHaveLength(0)
  })
})
