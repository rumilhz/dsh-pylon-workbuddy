/**
 * 启动就绪度：网关起没起来 + 有没有可用账号。
 *
 * ## 它解决什么
 *
 * 从零的环境（新电脑、空 `wb2api/`、零凭证）里，插件过去把用户留在一个**没有出口**
 * 的位置：`seed` 那一步打的是
 *
 * ```
 * ⚠ provider "workbuddy" 不存在，且写入 settings 失败：… resolves no models …
 * 把下面这段贴进 profile 的 cordis.patch.yml…（一段手工 YAML）
 * ```
 *
 * —— 建议他**手写 provider**，而真问题是「网关没装/没登录」。而「请执行
 * `/wb2api-login`」那类提示只活在 `/wb2api-status` / `/wb2api-account` 里，
 * 启动路径一次都不触发。2026-10-15 的「真·从零验证」实测：干净 home 下启动，
 * boot.log 与子进程输出两个通道命中 **0 条**指向前一步命令的指引。
 *
 * 本模块把「就绪还是没就绪」变成一个**结论**，并把「下一步敲什么」的文案集中在
 * {@link renderReadinessNextSteps} **一处**：启动路径负责播报（boot.log 锚点 +
 * stdout 两个通道），seed 那一步只读结论决定要不要打手工粘贴块。
 *
 * ## 分工（刻意的）
 *
 * · 本模块**不做任何 IO**，也不认识 cordis：事实由调用方采集（可注入、可单测），
 *   文案由本模块生成 —— 于是「什么算未就绪」与「未就绪时说什么」可以分开断言。
 * · 判定只看**本地事实 + 已缓存的探活结果**，不额外打一次网络：它在启动路径上，
 *   每加一次探活就是给「新用户第一眼看到什么」延后一次。
 *
 * @module dsh-pylon-workbuddy/startup-readiness
 */

/** 判定就绪度所需的事实（由调用方采集）。 */
export interface ReadinessFacts {
  /**
   * 解析到的网关可执行文件。
   * `undefined` = 查过了、没找到（**未安装**）—— 不是「没查」。
   */
  binaryPath?: string | undefined
  /** `supervisor.status().state`（`running` / `unhealthy` / `failed` / `stopped` / `external` / `starting`）。 */
  gatewayState?: string | undefined
  /** 探活拿到的可用账号数（supervisor 缓存的那一份）；没探到就是 `undefined`。 */
  healthy?: number | undefined
  /** 本地 `auths/` 里**启用中**的凭证文件数。 */
  enabledAccounts: number
}

/** 一条「为什么没就绪」。`short` 进括号（`未安装 / 未登录`），`detail` 给人看。 */
export interface ReadinessBlocker {
  short: string
  detail: string
}

/** 就绪度结论。 */
export interface StartupReadiness {
  /** 网关可用**且**有可用账号。 */
  ready: boolean
  /** 未就绪的原因（可能多条；`ready=true` 时为空数组）。 */
  blockers: ReadinessBlocker[]
}

/**
 * 判定就绪度。
 *
 * 三条互相独立的判据（**不是**层层短路：同时缺二进制又没账号时要一起说出来，
 * 否则用户修完一条还得再撞一次）：
 *
 * 1. **未安装** —— 解析不到网关可执行文件。
 * 2. **未登录** —— 本地 `auths/` 里 0 个启用凭证**且**探活也没报出可用账号。
 *    两个条件都要看：只看本地文件会把「凭证在别处（用户配了 `repoPath`/`workingDir`）
 *    但网关明明有账号」误判成未登录；只看探活则会在网关没起来时把「没账号」与
 *    「问不到」混为一谈。
 * 3. **网关未运行** —— 进程不在，且探活也没拿到任何账号。
 *    ★ 二进制都没有时**不报这一条**：那是上一条的后果，不是第二个病因
 *      （「没装所以没跑」不需要用户做两件事）。
 *
 * 账号在冷却（`healthy=0` 但**有**启用凭证）**不算未就绪**：那会自己恢复，
 * 让人去「登录」是错的指引（`/wb2api-status` 的逐号状态才是看它的地方）。
 *
 * @param facts - 采集到的事实。
 * @returns 结论。
 */
export function assessStartupReadiness(facts: ReadinessFacts): StartupReadiness {
  const blockers: ReadinessBlocker[] = []
  const healthy = facts.healthy ?? 0
  const installed = facts.binaryPath !== undefined
  if (!installed) {
    blockers.push({ short: '未安装', detail: '未找到网关可执行文件' })
  }
  if (facts.enabledAccounts === 0 && healthy === 0) {
    blockers.push({ short: '未登录', detail: '没有可用账号（auths/ 里 0 个启用凭证）' })
  }
  const gatewayUp = healthy > 0
    || facts.gatewayState === 'running'
    || facts.gatewayState === 'unhealthy'
    || facts.gatewayState === 'external'
  if (!gatewayUp && installed) {
    blockers.push({ short: '网关未运行', detail: `网关状态 ${facts.gatewayState ?? '未知（未托管）'}` })
  }
  return { ready: blockers.length === 0, blockers }
}

/** 指引里的两条命令：与 `/wb2api-setup` / `/wb2api-login` 命令面上的用法逐字一致。 */
export const SETUP_COMMAND_LINE = '  /wb2api-setup            ← 一键安装（会自动下载网关）'
export const LOGIN_COMMAND_LINE = '  /wb2api-login cn         ← 如果你还没有账号凭据（国内版）；国际版用 global'

/**
 * 把结论渲染成「下一步敲什么」。
 *
 * **就绪时返回空数组** —— 已经能用的人不需要被告知「下一步」（那只会变成噪音，
 * 也会让「未就绪」这个信号在日志里失去意义）。
 *
 * 文案只此一份：启动路径播报它，`seed` 那一步的失败文案引用它，
 * 以后若再加入口（比如设置卡片）也复用同一份，不写第二遍。
 *
 * @param readiness - {@link assessStartupReadiness} 的结论。
 * @returns 行数组（第一行说明原因，后两行是可直接照抄的命令）；就绪时 `[]`。
 */
export function renderReadinessNextSteps(readiness: StartupReadiness): string[] {
  if (readiness.ready) return []
  const shorts = readiness.blockers.map(blocker => blocker.short).join(' / ')
  const details = readiness.blockers.map(blocker => blocker.detail).join('；')
  return [
    `网关尚未就绪（${shorts}）—— ${details}。请先执行：`,
    SETUP_COMMAND_LINE,
    LOGIN_COMMAND_LINE,
  ]
}
