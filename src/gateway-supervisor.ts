/**
 * 网关子进程托管：定位可执行文件 → 探活 → 拉起 → 崩溃重启 → dispose 回收。
 *
 * 这是插件相对「手工常驻 wb2api 进程」的核心收益：dsh 启动时网关随之启动，
 * dsh 退出时网关随之释放（`dsh-subprocess` 的 dispose 会终止全部受管进程）。
 *
 * 两个必须尊重的既有事实：
 *  1. **子进程环境被清洗** —— `dsh-subprocess` 会移除凭据形名称与全部 `DSH_*`
 *     （`scrubbedParentEnv`）。网关需要的变量必须经 `spawn` 的显式 `env` 传入。
 *  2. **启动 ≠ 可用** —— 网关需要 `auths/*.json` 账号凭证；没有账号时 `/healthz`
 *     即使有响应也可能是 `healthy: 0`。因此探活必须解析 `healthy` / `total`，
 *     而不能只看 HTTP 200。
 *  3. ★ **「慢」不是「不在」** —— 探活**超时**与**端口无监听**是两件事，必须分开
 *     （见 {@link ProbeOutcome}）：前者禁止 `spawn`（端口上可能已经有服务，
 *     再拉一个只会撞端口，然后被记成「进程意外退出」），后者才可以。
 *
 * @module dsh-pylon-workbuddy/gateway-supervisor
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { gatewayOrigin, gatewayPort, type GatewayPluginConfig } from './config.js'
import { resolveAuthDir } from './auth-dir.js'
import { dshHome } from './plugin-state.js'

/** 探活结果。 */
export interface HealthReport {
  /** 可用账号数（`/healthz` 的 `healthy`）。 */
  healthy: number
  /** 账号总数（`/healthz` 的 `total`）。 */
  total: number
  /** 服务标识，网关固定为 `workbuddy2api`。 */
  service?: string
  /** 各 realm 是否可服务（`cn` / `global`）。 */
  realmServable?: Record<string, boolean>
  /** 原始响应体，便于状态命令透出更多字段。 */
  raw: Record<string, unknown>
}

/** 网关生命周期状态。 */
export type GatewayState = 'stopped' | 'external' | 'starting' | 'running' | 'unhealthy' | 'failed'

/** 状态命令使用的完整快照。 */
export interface GatewayStatus {
  /** 生命周期状态。`external` 表示端口上已有一个非本插件拉起的健康网关，已直接复用。 */
  state: GatewayState
  /** 端点根。 */
  baseURL: string
  /** 监听端口。 */
  port: number
  /** 实际使用的可执行文件路径（`external` 或未启动时可能缺席）。 */
  binaryPath?: string
  /** 本插件托管的子进程 pid（`external` 时缺席）。 */
  pid?: number
  /** 探活结果；未探到则为 undefined。 */
  health?: HealthReport
  /** 累计自动重启次数。 */
  restarts: number
  /** 最近一次失败原因。 */
  lastError?: string
  /**
   * 最近一次失败的**类别**（只有 `failed` 时才有意义）。
   *
   * `lastError` 是给人看的句子，随时可能改字；调用方要按病因改指引就得看这个字段
   * （就绪度指引：只有「没装 / 没登录」才该指 `/wb2api-setup` 与 `/wb2api-login`）。
   */
  lastFailure?: GatewayFailureKind
  /** 子进程 stderr 的尾部（诊断用）。 */
  recentStderr?: string
}

/** 子进程可执行文件的候选名（按优先级）。 */
const BINARY_CANDIDATES = [
  'wb2a-server.exe',
  'wb2api-server.exe',
  'wb2api.exe',
  'wb2a.exe',
  'wb2api-server',
  'wb2a-server',
  'wb2api',
  'wb2a',
]

/** 日志接口（与 cordis logger 的最小交集）。 */
export interface SupervisorLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** 托管器依赖。 */
export interface GatewaySupervisorOptions {
  config: GatewayPluginConfig
  subprocess: SubprocessRuntime
  logger: SupervisorLogger
  /** 注入 fetch，便于测试。 */
  fetchImpl?: typeof fetch
}

/**
 * 一次探活的结果。
 *
 * ## 为什么是三态而不是「报告 | undefined」
 *
 * 「没人听」与「有人听、但它没在预算内回答」在**调用点上后果完全不同**：
 *
 * · `no-listener` ⇒ 端口空闲 ⇒ **可以** `spawn`（这是「网关没起来，拉起来」的正常路径）；
 * · `unreachable`  ⇒ 端口上**可能已经有服务**（正在启动的网关 / 卡住的网关 / 别的程序）
 *   ⇒ **绝不能** spawn：同端口再 bind 会失败，子进程随即退出，于是
 *   「网关进程意外退出」+ 退避重启 ×N + `state=failed` —— 而那次误判的起因只是
 *   **一次超过 `healthTimeoutSeconds` 的往返**。
 *
 * 2026-10-15 实测（`tools/_stall-fetch.cjs` 注入停顿）：旧实现把**任何** fetch 异常
 * 都返回 `undefined`（= 文档里的「端口无监听」），于是给一个**正在应答**的假网关
 * 又 `spawn` 了一个进程；`statusWithHealth()` 也把在跑的网关报成 `stopped`。
 */
export type ProbeOutcome =
  | { kind: 'ok'; report: HealthReport }
  | { kind: 'no-listener' }
  /** 有监听但没回答 / 超时 / 传输失败。`reason` 是给人看的原因（会进 `lastError`）。 */
  | { kind: 'unreachable'; reason: string }

/**
 * 失败的**类别**（与给人看的 `lastError` 分开）。
 *
 * 就绪度指引要按病因给不同的下一步：端口上有服务却没应答时，打「请先
 * `/wb2api-setup` / `/wb2api-login`」是**错误指引**（网关可能正在启动，
 * 重装重登都不会让它变快）。类别是稳定的，句子可以随便改。
 */
export type GatewayFailureKind = 'port-unresponsive' | 'port-foreign'

/**
 * 判断错误是否表示「连接被拒」——即端口上**确实没有**服务在监听。
 *
 * 探活时这是**正常**结果（网关未启动），不是故障。
 *
 * ★ 必须收窄到 `ECONNREFUSED` 这一个 code（2026-10-15 修正）：
 * 旧实现里 `error.name === 'TypeError'` 一条会把**任意** undici `TypeError`
 * 算成拒连 —— 包括「URL 根本解析不了」（`baseURL` 写错）和别的传输失败。
 * 实测：`baseURL: 'not-a-url'` 时 `probe()` 返回「端口无监听」，
 * 于是插件会去拉一个本地网关，再把「配置写错」记成「30 秒内未就绪」。
 */
function isConnectionRefused(error: unknown): boolean {
  return findErrorCode(error) === 'ECONNREFUSED'
}

/**
 * 从错误链里找出第一个 `code`（undici 把底层错误塞在 `cause` 里）。
 *
 * 要展开 `AggregateError`：双栈主机（`::1` + `127.0.0.1`）同时连不上时，
 * fetch 抛的是 `TypeError('fetch failed')`，`cause` 是一个 AggregateError，
 * 它自己**没有** `code`，code 在 `cause.errors[]` 的每个成员上。
 */
function findErrorCode(error: unknown, seen: Set<unknown> = new Set()): string | undefined {
  if (error === null || typeof error !== 'object' || seen.has(error)) return undefined
  seen.add(error)
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  const nested = (error as { errors?: unknown }).errors
  if (Array.isArray(nested)) {
    for (const item of nested) {
      const found = findErrorCode(item, seen)
      if (found !== undefined) return found
    }
  }
  return findErrorCode((error as { cause?: unknown }).cause, seen)
}

/**
 * 把一次失败的探活翻译成给人看的**原因**。
 *
 * 这条兑现的是旧代码里那句没兑现的注释（「超时同样视作不可用，但保留原因供状态命令展示」
 * —— 当时三个分支都 `return undefined`，原因被整个丢掉）。
 */
function describeProbeFailure(error: unknown, url: string, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `${url} 在 ${timeoutMs}ms 内没有响应（超时）`
  }
  const message = error instanceof Error ? error.message : String(error)
  return `${url} 请求失败：${message}`
}

/** 把一份 `/healthz` 的 JSON 体转成探活报告（2xx 与 503 两条路共用，字段口径只有这一处）。 */
function toHealthReport(raw: Record<string, unknown>): HealthReport {
  const healthy = typeof raw.healthy === 'number' ? raw.healthy : 0
  const total = typeof raw.total === 'number' ? raw.total : 0
  return {
    healthy,
    total,
    ...typeof raw.service === 'string' ? { service: raw.service } : {},
    ...typeof raw.realm_servable === 'object' && raw.realm_servable !== null
      ? { realmServable: raw.realm_servable as Record<string, boolean> }
      : {},
    raw,
  }
}

/** 网关服务标识（`/healthz` 的 `service` 字段）。 */
const GATEWAY_SERVICE = 'workbuddy2api'

/**
 * 认出「**本网关**在跑、只是没有可用账号」的那种非 2xx。
 *
 * ## 为什么必须认（实测，不是推测）
 *
 * 网关没有可用账号时 `/healthz` 返回 **HTTP 503**，响应体仍是完整的健康结构：
 *
 * ```
 * HTTP 503  {"healthy":0,"realm_servable":{"cn":false,"global":false},"service":"workbuddy2api","total":0}
 * ```
 *
 * （仓库自己的 `docs/handoff-20260915-gateway-plugin.md` 第 268 行就记着
 * 「网关无账号 → `/healthz` 返回 503」；2026-10-15 的从零验证逐字抓到了它。）
 *
 * 不认这条形态，`waitForHealth()` 会把 503 当成「还没起来」，于是：
 *
 * ```
 * ① 白等满整个 30s 预算，最后报「自动启动 FAILED — 网关已拉起，但 30000ms 内
 *    /healthz 未就绪」—— 而网关其实**正在跑**，只是没账号。用户看到的
 *    「失败」是假的，`/wb2api-status` 的状态也会是「失败」而不是
 *    「运行中（无可用账号）」（后者才是 `GatewayState.unhealthy` 存在的意义）。
 * ② 端口上那个「正在跑但没账号」的网关会被判成**别的程序占用**，
 *    `start()` 拒绝复用它 —— 而它就是我们自己的网关。
 *
 * ## 判定刻意严格
 *
 * 只认 **503 + `service: workbuddy2api` + 数值 healthy/total**。于是
 * 「端口上是别的程序」（404、非 JSON、别的服务的 JSON）一律照旧抛错 ——
 * 那正是这个错误存在的意义（见 `gateway-supervisor.spec.ts` 的两条用例）。
 *
 * @param status - HTTP 状态码。
 * @param body - 响应体原文。
 * @returns 探活报告；不是「本网关的 503」时 `undefined`（调用方照旧抛错）。
 */
export function healthReportFromUnhealthyStatus(status: number, body: string): HealthReport | undefined {
  if (status !== 503) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (record['service'] !== GATEWAY_SERVICE) return undefined
  if (typeof record['healthy'] !== 'number' || typeof record['total'] !== 'number') return undefined
  return toHealthReport(record)
}

/**
 * 网关进程托管器。
 *
 * 生命周期与插件 fiber 绑定：`dispose()` 会终止本插件拉起的全部子进程。
 */
export class GatewaySupervisor {
  private readonly fetchImpl: typeof fetch
  private handle: SubprocessHandle | undefined
  private state: GatewayState = 'stopped'
  private restarts = 0
  private lastError: string | undefined
  /** 最近一次失败的类别（见 {@link GatewayStatus.lastFailure}）。 */
  private lastFailure: GatewayFailureKind | undefined
  /**
   * 最近一次**探活**失败的原因（探活层，不是进程层）。
   *
   * 单独存一份是因为两条通道都要用它：`waitForHealth()` 走满预算后要把它写进
   * `lastError`（不然用户只看到「未就绪」而不知道是超时还是没人听），
   * `statusWithHealth()` 要把它透给 `/wb2api-status`。
   */
  private lastProbeReason: string | undefined
  private resolvedBinary: string | undefined
  /**
   * 最近一次探活结果。
   *
   * 缓存它是因为 `start()` / `restart()` 内部**已经**探过一次活（用来决定
   * `running` / `unhealthy`），返回值却只给 `status()` —— 那份快照不含 `health`，
   * 于是调用方拿不到账号数（症状：「插件启动时 setup 消息没有账号信息」）。
   * 存下来由 {@link status} 一并带出，避免启动路径再补一次多余的探活。
   */
  private health: HealthReport | undefined
  /**
   * 正在进行中的启动。
   *
   * dsh 启动时插件会自动拉起网关（`autoStart`），而用户往往紧接着执行
   * `/wb2api-setup` 或 `/wb2api-start` —— 两个调用会撞在同一段时间里。
   * 没有这个字段时，第二次调用会走到 `handle !== undefined` 的早返回，
   * 拿到的是一份**还没有探活结果**的快照，报告里因此缺账号信息。
   * 有它则第二个调用直接等同一轮启动，拿到完整结果。
   */
  private inFlightStart: Promise<GatewayStatus> | undefined
  /**
   * 启动代际。
   *
   * 每次 `stop()` 递增，使**已经在跑的那一轮启动作废**：`/wb2api-account` 的顺序是
   * 「停 → 改名 → 启」，改名必须发生在进程真正停掉之后；若旧启动还活着，它会继续
   * 探活并写 `state` / `handle`，把改名夹在启动中间（表现为切换后账号集不对）。
   * `bringUp()` 在关键节点比对自己那一代的号，过期就直接放弃，不再改状态。
   */
  private startGeneration = 0
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  /** 显式停止标志：抑制「进程退出 → 自动重启」的联动。 */
  private stopping = false
  private disposed = false

  constructor(private readonly options: GatewaySupervisorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** 端点根（去掉 `/v1`），用于打 `/healthz`。 */
  private get origin(): string {
    return gatewayOrigin(this.options.config.baseURL)
  }

  /** 监听端口。 */
  private get port(): number {
    return gatewayPort(this.options.config.baseURL, this.options.config.listenPort)
  }

  /**
   * 解析网关可执行文件路径。
   *
   * 查找顺序（先显式配置，后推断，避免"配了却找不到"被静默忽略）：
   *  1. `binaryPath` 配置项 —— 显式指定，不存在则**直接报错**而不是继续找；
   *  2. `repoPath` 根目录及其 `bin/` 子目录下的候选名；
   *  3. `<DSH home>/wb2api/bin/` 缓存目录（插件自己的安装落点；`DSH_HOME` → `~/.dsh`）；
   *  4. 交给 `ctx.subprocess.resolveExecutable()` 走 PATH。
   *
   * @returns 可执行文件绝对路径。
   * @throws 全部候选都找不到时抛错，错误消息列出所有已尝试位置。
   */
  async resolveBinary(): Promise<string> {
    if (this.resolvedBinary !== undefined) return this.resolvedBinary

    const tried: string[] = []
    const { binaryPath, repoPath } = this.options.config

    if (binaryPath.length > 0) {
      if (existsSync(binaryPath)) {
        this.resolvedBinary = binaryPath
        return binaryPath
      }
      throw new Error(
        `workbuddy2api: 配置的 binaryPath 不存在：${binaryPath}。`
        + '请修正插件配置，或清空该项让插件自动探测。',
      )
    }

    const dirs: string[] = []
    if (repoPath.length > 0) {
      dirs.push(repoPath, join(repoPath, 'bin'))
    }
    dirs.push(join(dshHome(), 'wb2api', 'bin'))

    for (const dir of dirs) {
      for (const candidate of BINARY_CANDIDATES) {
        const full = join(dir, candidate)
        tried.push(full)
        if (existsSync(full)) {
          this.resolvedBinary = full
          return full
        }
      }
    }

    // 最后尝试 PATH（可能已全局安装）。
    for (const candidate of BINARY_CANDIDATES) {
      try {
        const resolved = await this.options.subprocess.resolveExecutable(candidate)
        this.resolvedBinary = resolved
        return resolved
      } catch {
        tried.push(`PATH:${candidate}`)
      }
    }

    throw new Error(
      'workbuddy2api: 未找到网关可执行文件。已尝试：\n  '
      + tried.join('\n  ')
      + '\n请设置插件配置 binaryPath，或把 repoPath 指向 workbuddy2api 源码目录。',
    )
  }

  /**
   * 决定子进程的工作目录。
   *
   * 顺序（先显式配置，再推断）：
   *  1. `workingDir` —— 用户显式指定；
   *  2. `repoPath` —— 用户有网关源码，其 `config.json` / `auths/` 就在这里；
   *  3. **`~/.dsh/wb2api/`（插件的运行目录）** —— 二进制由 `/wb2api-setup` 下载时，
   *     配置与凭证都放在那里（见 gateway-binary.ts 的 `ensureRuntimeDir`）；
   *  4. 可执行文件所在目录 —— 最后的兜底。
   *
   * 第 3 条不能省：网关的 `config.json` / `auth_dir` / `state_file` 全是**相对 cwd**
   * 的路径，cwd 指错地方就会去读一个不存在的配置（表现为启动即退出）。
   */
  private resolveWorkingDir(argv0: string): string {
    const { workingDir, repoPath } = this.options.config
    if (workingDir.length > 0) return workingDir
    if (repoPath.length > 0) return repoPath
    // 运行目录存在（含 config.json）时优先用它，否则退回可执行文件所在目录。
    // 基准与 `defaultRuntimeDir()` 同源（`DSH_HOME` → `~/.dsh`）：设了 `DSH_HOME`
    // 的隔离环境里，网关的 config.json / auths/ 也在那个 home 之下。
    const runtime = join(dshHome(), 'wb2api')
    if (existsSync(join(runtime, 'config.json'))) return runtime
    return join(argv0, '..')
  }

  /**
   * 探活 `GET /healthz`（**该端点无需鉴权**）。
   *
   * ★ 网关**没有可用账号**时该端点返回 **HTTP 503**（响应体仍是完整的健康结构）。
   *   这条形态必须认出来，否则会把「正在跑、只是没账号」误判成「端口被别的程序占用」
   *   或「还没起来」。实测后果见 {@link healthReportFromUnhealthyStatus}。
   *
   * 三态结果见 {@link ProbeOutcome}：**超时不是「没人听」**。
   *
   * @returns `ok` / `no-listener`（仅 `ECONNREFUSED`）/ `unreachable`（带原因）。
   * @throws 端口有监听、但 `/healthz` 既不是本网关的 2xx 也不是本网关的 503 时抛错
   *   ——「端口上是别的程序」是**确定性**结论，不重试、也不降级成 `unreachable`
   *   （那会把它和「慢」混为一谈，而那正是这次要修的病）。
   */
  async probe(): Promise<ProbeOutcome> {
    const url = `${this.origin}/healthz`
    const timeoutMs = this.options.config.healthTimeoutSeconds * 1000
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (isConnectionRefused(error)) return { kind: 'no-listener' }
      // 超时 / DNS 失败 / TLS 失败 / URL 写错 …… 一律是「这次没问出来」，
      // **不是**「没人听」。原因必须带回去（状态命令与失败文案都要用它）。
      return { kind: 'unreachable', reason: describeProbeFailure(error, url, timeoutMs) }
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      const report = healthReportFromUnhealthyStatus(response.status, body)
      if (report !== undefined) return { kind: 'ok', report }
      throw new Error(
        `workbuddy2api: ${this.origin} 上有服务在监听，但 /healthz 返回 HTTP ${response.status}`
        + `${body.length > 0 ? `：${body.slice(0, 200)}` : ''}。端口可能被其他程序占用。`,
      )
    }

    let raw: Record<string, unknown>
    try {
      raw = await response.json() as Record<string, unknown>
    } catch {
      throw new Error(`workbuddy2api: ${this.origin}/healthz 返回的不是 JSON，端口可能被其他程序占用。`)
    }

    return { kind: 'ok', report: toHealthReport(raw) }
  }

  /**
   * 启动前的一次「**决定性**」探活：`unreachable` 时重试，直到拿到 ok / no-listener。
   *
   * ## 为什么必须重试（而不是一超时就拒绝启动）
   *
   * `unreachable` 是**弱**结论：它可能是「端口上有个卡住的服务」，也可能只是这一次
   * 往返恰好超了预算（dsh 启动时整机在抢 IO、杀软过滤 loopback ……）。
   *
   * · 若不重试就拒绝 spawn：一次瞬时停顿会让**本来该起来**的网关起不来 ——
   *   那是拿「可用性」换「不撞端口」，不划算；
   * · 若像旧实现那样把它当 `no-listener` 去 spawn：端口上真有服务时，
   *   子进程 bind 失败 → 记成「意外退出」→ 退避重启 ×N → `state=failed`，
   *   用户看到的是**假的**失败。
   *
   * 重试能把这两种都判对：瞬时停顿会收敛成决定性答案，持续不回答才拒绝 spawn。
   * 端口上是**别的程序**（probe 抛错）时**不重试** —— 那是决定性结论。
   */
  private async probeDecision(attempts = 3, delayMs = 250): Promise<ProbeOutcome> {
    let last: ProbeOutcome = { kind: 'unreachable', reason: '未执行探活' }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await new Promise(resolve => { setTimeout(resolve, delayMs) })
      last = await this.probe()
      if (last.kind !== 'unreachable') return last
    }
    return last
  }

  /**
   * 统计网关实际读取的 `auths/` 目录下的凭证文件数（诊断「网关起来了但没有账号」）。
   *
   * ★ 目录口径与 {@link AccountStore.authDir} **同一个来源**（{@link resolveAuthDir}），
   * 这是 2026-10-15 修掉的第二处误报：
   *
   * · 旧实现固定拼 `<基准>/auths`，**不读** `config.json` 的 `auth_dir`；
   * · 而登录（`/wb2api-login`）与账号切换写的是 `AccountStore.authDir()`，
   *   它会读 `auth_dir`；
   * ⇒ 用户把 `auth_dir` 改成 `./creds` 之后，这个数字**永远是 0**，
   *   而它出现的场合全是**解释为什么没有可用账号**的提示文案 ——
   *   那句「auths/ 下 0 个凭证文件」会把用户指向一个空的默认目录去排查。
   */
  countAuthFiles(): number {
    try {
      const dir = resolveAuthDir(this.options.config)
      if (!existsSync(dir)) return 0
      return readdirSync(dir).filter(name => name.endsWith('.json')).length
    } catch {
      return 0
    }
  }

  /**
   * 启动网关。
   *
   * 行为分三种：
   *  - 端口上已有**健康**网关 → 直接复用（`external`），不重复拉起。
   *    这正是「用户已手工常驻网关」场景下的正确行为，也避免了端口冲突。
   *  - 端口被非网关程序占用 → 抛错。
   *  - 端口空闲 → 解析二进制并 spawn，随后轮询 `/healthz` 直到就绪或超时。
   *
   * **并发调用会等待同一次启动**（见 {@link inFlightStart}）：dsh 启动时的自动
   * 拉起与用户紧接着执行的 `/wb2api-setup` 会撞在一起，若第二个调用直接返回
   * 「启动中」的半成品快照，报告里就不会有账号信息。
   *
   * @returns 启动后的状态快照（含探活结果）。
   */
  async start(): Promise<GatewayStatus> {
    // 已有一轮启动在跑：等它，而不是回一个「启动中」的空壳。
    if (this.inFlightStart !== undefined) return this.inFlightStart
    if (this.handle !== undefined || this.state === 'external') return this.status()

    const pending = this.bringUp()
    this.inFlightStart = pending
    try {
      return await pending
    } finally {
      // 只清掉**自己那一轮**：`stop()` 会把标记置空以便新一轮启动立即落位，
      // 若无条件清除，A 轮结束时会把 B 轮的标记抹掉，第三个调用又会拿到空壳快照。
      if (this.inFlightStart === pending) this.inFlightStart = undefined
    }
  }

  /** {@link start} 的实际启动流程（已被并发去重包裹）。 */
  private async bringUp(): Promise<GatewayStatus> {
    const generation = this.startGeneration
    /** 本轮是否已被 stop() 作废。 */
    const stale = (): boolean => generation !== this.startGeneration

    this.stopping = false
    this.state = 'starting'
    this.lastError = undefined
    this.lastFailure = undefined
    this.lastProbeReason = undefined

    // 1. 先探：已有健康网关就直接复用。
    //
    // 这里的 try 只包**探活本身**：probe() 抛错 = 端口上是别的程序（决定性结论），
    // 原样变成 state=failed + 同一条文案（与旧行为逐字一致）。别的分支在下面平铺。
    let existing: ProbeOutcome
    try {
      existing = await this.probeDecision()
    } catch (error) {
      if (stale()) return this.status()
      this.state = 'failed'
      this.lastFailure = 'port-foreign'
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
    // 探活期间被 stop() 作废（如 /wb2api-account 正在改名）：不要写任何状态，
    // 否则会给一个已经决定停掉的网关标上 external。
    if (stale()) return this.status()

    if (existing.kind === 'ok') {
      this.state = 'external'
      this.options.logger.info(
        `[workbuddy2api] 复用已在 ${this.origin} 运行的网关（healthy=${existing.report.healthy}/${existing.report.total}）`,
      )
      // 把刚探到的结果带进返回值：调用方（/wb2api-setup、/wb2api-start、自动启动）
      // 都靠 status.health 汇报账号可用性，丢掉它就只能显示「运行中」而没有账号数。
      this.health = existing.report
      return this.status()
    }

    if (existing.kind === 'unreachable') {
      // ★ 不 spawn：端口上**可能**已经有服务（正在启动的网关 / 卡住的网关 / 别的程序）。
      //   旧实现把它当「端口无监听」⇒ 又拉一个子进程 ⇒ 同端口 bind 失败 ⇒
      //   「进程意外退出」+ 退避重启 ×N，而网关其实在跑（2026-10-15 实测 D2）。
      this.state = 'failed'
      this.lastFailure = 'port-unresponsive'
      this.lastError = `workbuddy2api: ${existing.reason}。`
        + `为免与 ${this.origin} 上可能已存在的服务撞车，本次**不**自动拉起新进程。`
        + '若那是本网关，它可能正在启动或响应过慢 —— 稍后重试 /wb2api-start；'
        + '若端口被别的程序占用，请释放该端口，或改插件的 baseURL / listenPort。'
      this.options.logger.error(`[workbuddy2api] ${this.lastError}`)
      throw new Error(this.lastError)
    }

    // existing.kind === 'no-listener'：端口确实没人听，按老路拉起。

    // 2. 拉起受管进程。
    const argv0 = await this.resolveBinary()
    if (stale()) return this.status()
    const cwd = this.resolveWorkingDir(argv0)

    this.options.logger.info(`[workbuddy2api] 启动网关：${argv0}（cwd=${cwd}）`)
    const handle = this.options.subprocess.spawn({
      argv: [argv0],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 64 * 1024, spill: { maxBytes: 4 * 1024 * 1024 } },
        stderr: { maxBytes: 64 * 1024, spill: { maxBytes: 4 * 1024 * 1024 } },
      },
      graceMs: this.options.config.graceMs,
      // 子进程环境被 dsh 清洗过（凭据形名称 + DSH_* 全移除），
      // 网关需要的变量必须在这里显式传入。
      env: { ...this.options.config.env },
    })
    this.handle = handle
    void this.watchExit(handle)

    // 3. 轮询探活，等网关真正可用。
    const health = await this.waitForHealth(handle)
    // 探活期间被 stop() 作废：进程可能已被销毁，不能再用这轮结果写状态。
    if (stale()) return this.status()
    if (health === undefined) {
      this.state = 'failed'
      // 子进程若已退出，watchExit 已经写下更准确的病因（退出码/信号），不要覆盖它 ——
      // 那种情况是「进程崩了」，不是「端口上有个不回答的服务」，类别也不能写错。
      if (this.lastError === undefined) {
        // ★ 带上探活层的原因：只说「未就绪」时，「超时」与「没人听」在日志里长得一样，
        //   而两者的下一步完全不同（前者看网关在忙什么，后者看进程为什么没起来）。
        this.lastError = `网关已拉起，但 ${this.healthDeadlineMs()}ms 内 /healthz 未就绪`
          + `${this.lastProbeReason !== undefined ? `（最近一次探活：${this.lastProbeReason}）` : ''}`
        this.lastFailure = 'port-unresponsive'
      }
      this.options.logger.error(`[workbuddy2api] ${this.lastError}`)
      return this.status()
    }

    this.state = health.healthy > 0 ? 'running' : 'unhealthy'
    this.health = health
    if (health.healthy === 0) {
      // 进程活着但没账号：明确告知，而不是假装成功。
      const authFiles = this.countAuthFiles()
      this.options.logger.warn(
        `[workbuddy2api] 网关已启动，但可用账号为 0（auths/ 下 ${authFiles} 个凭证文件）。`
        + '请先完成登录（/wb2api-login）。',
      )
    }
    return this.status()
  }

  /**
   * 启动后等待 `/healthz` 就绪的总预算（毫秒）。
   *
   * 取 `healthTimeoutSeconds` 的 10 倍：单次探活超时是「网络往返」级别的耐心，
   * 而进程启动还要加载账号池与状态文件，需要更长的总预算。
   */
  private healthDeadlineMs(): number {
    return this.options.config.healthTimeoutSeconds * 1000 * 10
  }

  /** 轮询探活直到就绪、进程退出或超时。 */
  private async waitForHealth(handle: SubprocessHandle): Promise<HealthReport | undefined> {
    const deadline = Date.now() + this.healthDeadlineMs()
    // 进程退出也必须立刻结束等待：否则一个「起了就退」的二进制会让我们白等满整个预算。
    // 这里显式 race 而不是靠 this.handle 被 watchExit 清空 —— 后者与 watchExit 的
    // 异步推进存在竞态，可能导致 lastError 尚未写入就被读取。
    const exited = handle.done.then(() => 'exited' as const, () => 'exited' as const)
    while (Date.now() < deadline) {
      const outcome = await Promise.race([
        // 探活的三态在这里的含义：
        //   ok          ⇒ 就绪，返回报告；
        //   no-listener ⇒ 进程还没 bind 上，继续等（与旧行为一致）；
        //   unreachable ⇒ 端口在应答但没给出 health（超时/传输失败）⇒ 继续等，
        //                 并**留下原因**供超时文案使用（旧实现把它和 no-listener 一起吞掉）。
        // probe() 抛错（端口上是别的程序）与旧行为一致：当作"还没就绪"，继续轮询。
        this.probe().then(
          (result): HealthReport | 'unhealthy' => {
            if (result.kind === 'ok') return result.report
            this.recordProbeReason(result)
            return 'unhealthy'
          },
          () => 'unhealthy' as const,
        ),
        exited,
        new Promise<'tick'>(resolve => { setTimeout(() => resolve('tick'), 250) }),
      ])
      if (outcome === 'exited') {
        // 让 watchExit 完成它那半边状态更新，保证 lastError 已就绪。
        await Promise.resolve()
        return undefined
      }
      if (outcome !== 'unhealthy' && outcome !== 'tick') return outcome
    }
    return undefined
  }

  /** 记下探活层的失败原因（超时/DNS/传输失败），供超时文案与状态命令展示。 */
  private recordProbeReason(outcome: ProbeOutcome): void {
    if (outcome.kind === 'unreachable') this.lastProbeReason = outcome.reason
  }

  /** 监视子进程退出，按策略自动重启。 */
  private async watchExit(handle: SubprocessHandle): Promise<void> {
    let outcome: { exitCode: number | null; signal: string | null }
    try {
      outcome = await handle.done
    } catch (error) {
      outcome = { exitCode: null, signal: null }
      this.lastError = `网关进程启动失败：${error instanceof Error ? error.message : String(error)}`
    }
    if (this.handle !== handle) return // 已被主动替换/停止
    this.handle = undefined

    if (this.stopping || this.disposed) {
      this.state = 'stopped'
      return
    }

    this.lastError = `网关进程意外退出（exitCode=${String(outcome.exitCode)} signal=${String(outcome.signal)}）`
    this.options.logger.warn(`[workbuddy2api] ${this.lastError}`)

    if (this.restarts >= this.options.config.crashRestartLimit) {
      this.state = 'failed'
      this.lastError += `；已达自动重启上限 ${this.options.config.crashRestartLimit} 次，停止重启。`
      this.options.logger.error(`[workbuddy2api] ${this.lastError}`)
      return
    }

    this.restarts += 1
    // 退避重启：避免二进制损坏时疯狂拉起。
    const delayMs = Math.min(1000 * 2 ** (this.restarts - 1), 30_000)
    this.options.logger.info(`[workbuddy2api] ${delayMs}ms 后自动重启（第 ${this.restarts} 次）`)
    this.state = 'starting'
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (this.disposed || this.stopping) return
      void this.start().catch((error: unknown) => {
        this.options.logger.error(`[workbuddy2api] 自动重启失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }, delayMs)
    this.restartTimer.unref?.()
  }

  /**
   * 停止本插件拉起的网关进程。
   *
   * `external` 状态（复用他人启动的网关）下**不会**去杀别人的进程 —— 只解除复用。
   */
  async stop(): Promise<void> {
    this.stopping = true
    // 作废进行中的启动：`/wb2api-account` 是「停 → 改名 → 启」，改名必须发生在
    // 进程真正停掉之后。递增代际会让旧的 bringUp() 在下一个检查点放弃，
    // 不再写 state / handle（否则会把改名夹在启动中间，切换后账号集不对）。
    this.startGeneration += 1
    this.inFlightStart = undefined
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const handle = this.handle
    this.handle = undefined
    if (handle !== undefined) {
      handle.terminate()
      // 等受管进程范围真正空掉，避免快速重启时端口还没释放。
      await handle.waitForExit(AbortSignal.timeout(this.options.config.graceMs + 5000)).catch(() => false)
    }
    this.state = 'stopped'
    this.restarts = 0
  }

  /** 停止后重新启动（用于 `/wb2api-restart`）。 */
  async restart(): Promise<GatewayStatus> {
    await this.stop()
    this.stopping = false
    this.restarts = 0
    return this.start()
  }
  /** 当前状态快照。 */
  status(): GatewayStatus {
    const stderr = this.handle?.collected.stderr?.readFrom(0).text
    return {
      state: this.state,
      baseURL: this.options.config.baseURL,
      port: this.port,
      ...this.resolvedBinary !== undefined ? { binaryPath: this.resolvedBinary } : {},
      ...this.health !== undefined ? { health: this.health } : {},
      ...this.lastError !== undefined ? { lastError: this.lastError } : {},
      ...this.lastFailure !== undefined ? { lastFailure: this.lastFailure } : {},
      restarts: this.restarts,
      ...stderr !== undefined && stderr.length > 0 ? { recentStderr: stderr.slice(-2000) } : {},
    }
  }

  /** 带实时探活的状态快照（供 `/wb2api-status` 使用）。 */
  async statusWithHealth(): Promise<GatewayStatus> {
    const base = this.status()
    // 状态里没有 pid：subprocess 句柄不暴露 pid，用探活结果代替进程存活性判断。
    try {
      const outcome = await this.probe()
      if (outcome.kind === 'ok') {
        // 实时结果覆盖缓存（缓存只是「上次启动时看到的」，可能已过期）。
        this.health = outcome.report
        return { ...base, health: outcome.report, state: base.state === 'stopped' ? 'external' : base.state }
      }
      if (outcome.kind === 'unreachable') {
        // ★ 兑现「保留原因供状态命令展示」：这里以前是**静默**返回旧快照，
        //   于是「网关在跑但这次探活超时」在 `/wb2api-status` 里看起来就是
        //   「没探到」，与「端口上没人听」完全一样（实测 D3：报 state=stopped）。
        return { ...base, lastError: `探活未拿到响应：${outcome.reason}` }
      }
    } catch (error) {
      return { ...base, lastError: error instanceof Error ? error.message : String(error) }
    }
    // no-listener：端口上没人听，保持旧快照（调用方据此显示「未运行」）。
    return base
  }

  /** 安装/卸载用的清理入口：终止全部受管进程，不再重启。 */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }
}
