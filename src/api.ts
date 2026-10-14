/**
 * 设置卡片的**后端半边**：宿主 web 路由上的两个端点。
 *
 * ## 为什么必须由宿主代理，而不是卡片直连网关
 *
 * 卡片跑在浏览器里，而网关要 `Authorization: Bearer <api_key>`、且是跨源回环端点。
 * 把 api_key 交给浏览器等于把它交给页面上任何一个脚本；再加上桌面端的 `/api/*` 栅栏，
 * 直连根本走不通。所以：**卡片只跟宿主说话，宿主跟网关说话**。
 *
 * ## 只有两个端点（先小后大）
 *
 * ```
 * GET  <prefix>/panel    —— 一次性返回卡片要的全部数据
 * POST <prefix>/action   —— { action: 'rebuild' | 'checkin' | 'test', … }
 * ```
 *
 * ## 与传输无关
 *
 * 数据组装（{@link createPanelApi}）与 HTTP 传输（{@link createHostRouteHandler}）是
 * 两件事：前者只依赖注入进来的几个函数，因此可以在**没有 DSH、没有网关**的情况下离线断言
 * 响应形状与「什么情况下真的发请求」；后者才碰 `req` / `res`。
 *
 * ## 两条硬纪律
 *
 * 1. **不许假装有数据**：拿不到的部分给 `null`，整块拿不到就给 `null` + `ok:false` + `detail`。
 * 2. **不许有隐式动作**：`/panel` 是纯只读的（只发 GET）；只有 `/action` 会改变状态，
 *    而 `test` 还必须额外带 `confirm: true` —— 它会真的花额度。
 *
 * @module dsh-workbuddy2api/api
 */

import { gatewayOrigin } from './config.js'
import { maskNickname } from './nickname.js'
import type { AuthAccount } from './accounts.js'
import type { SeedOutcome } from './provider-config.js'

/**
 * 裸前缀：宿主 web 服务器直接答的那条。
 *
 * 与 `dsh-trae` 的 `/plugins/dsh-trae`、`dsh-subagent-router` 的 `/router-dispatch`
 * 同一层（都是 `webServer.register({ kind: 'prefix', … })`）。
 */
export const ROUTE_PREFIX = '/wb2api'

/**
 * 框架自己的 API 前缀（`dsh-client-connection/lib/index.js`：`const API_PATH = "/api"`）。
 *
 * ★ **实测事实**（见 `_施工说明-从Trae搬能力.md` C1.2/§C1.3）：桌面 app 的界面层
 * **只把 `/api/*` 转给宿主**，裸路径会被那一层自己挡成 403。所以两条都要挂 ——
 * 直连宿主的走裸路径，经 app 代理的走 `/api/...`。
 */
export const API_ROUTE_PREFIX = '/api'

/** ★ 必须**同时**挂上的两条前缀（顺序：裸的在前，与兄弟插件一致）。 */
export const ROUTE_PATHS: readonly string[] = [ROUTE_PREFIX, `${API_ROUTE_PREFIX}${ROUTE_PREFIX}`]

/** 卡片请求体上限：这里每个动作都只有一个很小的 JSON 对象。 */
export const ROUTE_BODY_LIMIT = 64 * 1024

/** 免费档倍率的字面量（`/v1/models` 的 `credits` 字段；本机实测 5 个模型是它）。 */
export const FREE_CREDIT_TIER = 'x0.00'

/**
 * 签到那一行的说明（面板直接渲染）。
 *
 * ★ 口径来自合规红线（`_勘察-网关能力.md` §4 引官方原文）：官方明文禁止
 * 「利用脚本、外挂、插件、模拟器、**接口调用**……刷取活跃或奖励」。所以本插件
 * **只做「用户显式点一次」**，没有任何自动签到路径；这句话必须让用户看见。
 */
export const CHECKIN_NOTE =
  '签到由插件**直连上游**（www.codebuddy.cn）完成，不经网关；' +
  '只在点击时执行一次。插件**没有**任何自动签到路径 —— 官方明文禁止用接口调用刷活跃。'

/** 注入用的 fetch 形状（与 `login.ts` 的同名类型结构一致，刻意各写一份以免耦合）。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** 到网关的一次 GET 的结果（绝不抛：失败也是一种结果）。 */
interface JsonRead {
  ok: boolean
  status?: number
  body?: unknown
  error?: string
}

/* ── 响应契约（前端照这个写） ─────────────────────────────────────────────── */

/** 网关可达性。`healthy` / `total` 只有真读到 `/healthz` 或 `/status` 时才是数字。 */
export interface PanelGateway {
  reachable: boolean
  origin: string
  healthy: number | null
  total: number | null
}

/** 一个账号。★ `nickname` **必定已脱敏**（`maskNickname`，手机号打码、其余原样）。 */
export interface PanelAccount {
  uid: string
  nickname: string
  realm: string
  /** 网关 `/status` 报的积分；网关不可达或未上报时为 `null`（**不是 0**）。 */
  credits: number | null
  cooling: boolean
  /** 「当前不可用」：文件被改名禁用、或网关侧 disabled，任一成立。 */
  disabled: boolean
}

/** 积分块。整块拿不到时（网关不可达）是 `null`。 */
export interface PanelCredits {
  /** 已知积分之和（未知的不计入 —— 这是**下界**，不是估计值）。 */
  total: number
  accounts: PanelAccount[]
}

/** 模型目录对照。三段各自独立，拿不到的字段是 `null`。 */
export interface PanelModels {
  /** 网关 `/v1/models` 的条目数。 */
  gatewayTotal: number | null
  /** 网关目录里**没有 `credits` 倍率**的条目数（单价未知，测试前要提醒）。 */
  unknownPrice: number | null
  /** 「设置 → 模型」里那份可编辑 provider 声明的模型数。 */
  providerModelCount: number | null
}

/** 可编辑 provider 的现状。 */
export interface PanelProvider {
  exists: boolean
  ns: string | null
  /** 墓碑（迄今提供过）里的 id 个数；`null` = 没有记录（与「记录是空的」不同义）。 */
  lastOffered: number | null
}

/** 按模型的用量台账（来自 `GET /v1/stats`）。 */
export interface PanelUsage {
  enabled: boolean
  /** 计数起点（网关启动或上次 reset）；**它一变就说明计数归零了**。 */
  since: string | null
  requests: number
  credit: number
  uptimeSec: number | null
  /**
   * 按模型一行。
   *
   * `id` 与 `model` 是**同一个值**：网关自己的字段名是 `model`（`/v1/stats` 的
   * `models[].model`），而卡片侧按 `id` 读 —— 两个都给，免得一侧改名另一侧白屏。
   */
  models: Array<{
    id: string
    model: string
    requests: number | null
    credit: number | null
    totalTokens: number | null
  }>
  note: string
}

/** 签到能力说明。 */
export interface PanelCheckin {
  supported: boolean
  note: string
}

/** `GET <prefix>/panel` 的响应体。 */
export interface PanelBody {
  ok: boolean
  detail?: string
  gateway: PanelGateway
  credits: PanelCredits | null
  models: PanelModels
  provider: PanelProvider
  usage: PanelUsage | null
  checkin: PanelCheckin
}

/** `/action` 的响应体。各动作在 `ok` / `detail` 之外各自带字段。 */
export type ActionBody = { ok: boolean; detail?: string } & Record<string, unknown>

/** 用户显式触发的一次签到的结果。 */
export interface CheckinActionOutcome {
  /** 真的发了那个 POST 没有。`false` 时 `detail` 说明为什么没发。 */
  attempted: boolean
  ok: boolean
  detail: string
}

/** 测试动作的入参（来自请求体，全部可选）。 */
export interface TestActionRequest {
  model?: string
  prompt?: string
  maxTokens?: number
  /** ★ 必须显式给 `true`：这个动作会真的花额度。 */
  confirm?: boolean
}

/** {@link createPanelApi} 的注入点。全部由 `index.ts` 提供，便于离线测试。 */
export interface PanelApiDeps {
  /** 网关 OpenAI 兼容端点根，如 `http://127.0.0.1:7863/v1`。 */
  baseURL: string
  /** 可编辑 provider 的键名。 */
  providerName: string
  /** 单次读超时（毫秒）。 */
  timeoutMs: number
  /** 测试动作的整体超时（毫秒）—— 一次真实补全比一次探活慢得多。 */
  chatTimeoutMs?: number
  /** 网关 api_key；拿不到就 `undefined`（网关 api_key 为空时完全放行，照样能读）。 */
  resolveApiKey: () => Promise<string | undefined>
  /** fetch 替身（缺省用全局 `fetch`）。 */
  fetchImpl?: FetchLike
  /** 本地凭证文件清单（`AccountStore.list()`）。 */
  listAccounts: () => AuthAccount[]
  /** 可编辑 provider 的现状；`settings` 不可用时返回 `undefined`。 */
  providerFacts?: () => Promise<{ exists: boolean; ns: string | null; modelCount: number | null } | undefined>
  /** 墓碑里的 id 个数；`undefined` = 没有记录。 */
  lastOffered?: () => number | undefined
  /** 重建清单（走 `ensureEditableProvider(…, overwrite=true)` 那条路）。 */
  rebuild: () => Promise<SeedOutcome>
  /** 用户显式触发的签到（直连上游）。 */
  checkin: () => Promise<CheckinActionOutcome>
  /** 轨迹锚点（缺省丢弃）。 */
  trace?: (line: string) => void
}

/** 与传输无关的那一半：两个端点各自的数据组装。 */
export interface PanelApi {
  panel(): Promise<PanelBody>
  action(body: unknown): Promise<ActionBody>
}

/* ── 小工具（都刻意不抛） ─────────────────────────────────────────────────── */

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 一次 GET + JSON 解析。**任何失败都返回 `{ok:false, error}`，绝不抛。** */
async function getJson(
  fetchImpl: FetchLike,
  url: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<JsonRead> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...apiKey !== undefined && apiKey !== '' ? { authorization: `Bearer ${apiKey}` } : {},
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` }
    try {
      return { ok: true, status: response.status, body: await response.json() }
    } catch (error) {
      return { ok: false, status: response.status, error: `响应不是 JSON：${msg(error)}` }
    }
  } catch (error) {
    return { ok: false, error: msg(error) }
  }
}

/**
 * 挑一个「签到用它」的账号：**第一个启用的 CN 账号**。
 *
 * 只认 CN 的理由在 `login.ts` 的 `realmEndpoints`：`checkinBase` 只有 CN 有，
 * global 的签到端点上游自己都标注未实测 ⇒ 拿 global 账号去签是拿用户账号做实验。
 */
export function pickCheckinAccount(accounts: readonly AuthAccount[]): AuthAccount | undefined {
  return accounts.find(account => account.enabled && account.realm === 'cn')
}

/** 从 `/status` 的 `accounts[]` 建 uid → 实时字段的索引。 */
function indexLive(status: Record<string, unknown> | undefined): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  const raw = status?.['accounts']
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    if (!isDict(item)) continue
    const uid = str(item['uid'])
    if (uid !== null) out.set(uid, item)
  }
  return out
}

/**
 * 合并「本地凭证文件」与「网关实时台账」成一个账号列表。
 *
 * 两边都列是刻意的：本地文件已禁用而网关仍在池中（改名后没重启）、或反过来（网关刚重启
 * 还没加载），这两种不一致本身就是最有用的诊断信号；只列一边会让它消失。
 */
function buildCredits(accounts: readonly AuthAccount[], status: Record<string, unknown> | undefined): PanelCredits {
  const live = indexLive(status)
  const rows: PanelAccount[] = []
  const seen = new Set<string>()
  for (const account of accounts) {
    const entry = live.get(account.uid)
    const liveNickname = str(entry?.['nickname'])
    rows.push({
      uid: account.uid,
      // 网关报的昵称优先（它更权威）；两边都拿不到就是空串。
      nickname: maskNickname(liveNickname ?? account.nickname),
      realm: account.realm,
      credits: num(entry?.['credits']),
      cooling: entry?.['cooling'] === true,
      disabled: !account.enabled || entry?.['disabled'] === true,
    })
    seen.add(account.uid)
  }
  for (const [uid, entry] of live) {
    if (seen.has(uid)) continue
    rows.push({
      uid,
      nickname: maskNickname(str(entry['nickname']) ?? ''),
      realm: str(entry['realm']) ?? 'cn',
      credits: num(entry['credits']),
      cooling: entry['cooling'] === true,
      disabled: entry['disabled'] === true,
    })
  }
  const total = rows.reduce((sum, row) => sum + (row.credits ?? 0), 0)
  return { total, accounts: rows }
}

/** 网关目录 → 条目数与「单价未知」条目数。 */
function buildModels(catalog: unknown, providerModelCount: number | null): PanelModels {
  const data = isDict(catalog) ? catalog['data'] : undefined
  const list = Array.isArray(data) ? data : undefined
  return {
    gatewayTotal: list === undefined ? null : list.length,
    unknownPrice: list === undefined
      ? null
      : list.filter((row) => str(isDict(row) ? row['credits'] : undefined) === null).length,
    providerModelCount,
  }
}

/** `GET /v1/stats` → 用量块。 */
function buildUsage(stats: Record<string, unknown> | undefined): PanelUsage | null {
  if (stats === undefined) return null
  const total = isDict(stats['total']) ? stats['total'] : {}
  const rows = Array.isArray(stats['models']) ? stats['models'] : []
  return {
    enabled: stats['enabled'] === true,
    since: str(stats['since']),
    requests: num(total['requests']) ?? 0,
    credit: num(total['credit']) ?? 0,
    uptimeSec: num(stats['uptime_sec']),
    models: rows.filter(isDict).map((row) => {
      const id = str(row['model']) ?? '?'
      return { id, model: id, requests: num(row['requests']), credit: num(row['credit']), totalTokens: num(row['total_tokens']) }
    }),
    // 这两句必须一起透出，否则「重启后归零」会被读成「没用量」、「credit」会被读成真值。
    note: 'credit 只统计上游在 usage 里给了 credit 的请求 ⇒ 这是**下界**；'
      + 'since 变化说明网关重启过（计数从零开始）。',
  }
}

/* ── 数据面 ───────────────────────────────────────────────────────────────── */

/** 一次 `/panel` 里从网关读到的四份载荷（各自独立，缺哪个都不影响别的）。 */
interface GatewayRead {
  origin: string
  reachable: boolean
  detail: string | undefined
  health?: Record<string, unknown>
  status?: Record<string, unknown>
  catalog?: unknown
  stats?: Record<string, unknown>
}

async function readGateway(deps: PanelApiDeps, fetchImpl: FetchLike): Promise<GatewayRead> {
  const origin = gatewayOrigin(deps.baseURL)
  const base = deps.baseURL.replace(/\/+$/, '')
  let apiKey: string | undefined
  try {
    apiKey = await deps.resolveApiKey()
  } catch (error) {
    deps.trace?.(`api: 解析网关 api_key 抛错 —— ${msg(error)}（继续按无凭据读）`)
    apiKey = undefined
  }
  const timeout = Math.max(500, deps.timeoutMs)
  const [health, status, models, stats] = await Promise.all([
    // `/healthz` 免鉴权 —— 它是「网关在不在」最便宜的一条探针。
    getJson(fetchImpl, `${origin}/healthz`, undefined, timeout),
    getJson(fetchImpl, `${origin}/status`, apiKey, timeout),
    getJson(fetchImpl, `${base}/models`, apiKey, timeout),
    getJson(fetchImpl, `${origin}/v1/stats`, apiKey, timeout),
  ])
  const reachable = health.ok || status.ok || models.ok
  // 诊断用的第一个失败原因：探活优先（它最能说明"网关根本没起来"）。
  const firstError = [health, status, models].find(read => !read.ok)
  return {
    origin,
    reachable,
    detail: reachable ? undefined : (firstError?.error ?? '网关没有任何响应'),
    ...isDict(health.body) ? { health: health.body } : {},
    ...isDict(status.body) ? { status: status.body } : {},
    ...models.ok ? { catalog: models.body } : {},
    ...isDict(stats.body) ? { stats: stats.body } : {},
  }
}

/**
 * 造出与传输无关的那一半。
 *
 * @param deps - 注入点（全部来自 `index.ts`；测试里全部是替身）。
 * @returns `{ panel, action }`。
 */
export function createPanelApi(deps: PanelApiDeps): PanelApi {
  const fetchImpl = deps.fetchImpl ?? fetch
  const trace = deps.trace ?? ((): void => {})

  const providerFacts = async (): Promise<{ exists: boolean; ns: string | null; modelCount: number | null }> => {
    try {
      const facts = await deps.providerFacts?.()
      return facts ?? { exists: false, ns: null, modelCount: null }
    } catch (error) {
      trace(`api: 读可编辑 provider 现状抛错 —— ${msg(error)}`)
      return { exists: false, ns: null, modelCount: null }
    }
  }

  const panel = async (): Promise<PanelBody> => {
    let accounts: AuthAccount[] = []
    try {
      accounts = deps.listAccounts()
    } catch (error) {
      trace(`api: 列凭证文件抛错 —— ${msg(error)}`)
    }
    const gatewayRead = await readGateway(deps, fetchImpl)
    const facts = await providerFacts()
    let lastOffered: number | undefined
    try {
      lastOffered = deps.lastOffered?.()
    } catch (error) {
      trace(`api: 读墓碑抛错 —— ${msg(error)}`)
      lastOffered = undefined
    }
    const health = gatewayRead.health
    const status = gatewayRead.status
    // 账号台账（`/status`）优先于免鉴权的 `/healthz`：`credits` 就来自前者，
    // 两个数放在一起必须同源，否则会出现「2 个账号 / total=1」这种自相矛盾的面板。
    // 只有拿不到 `/status`（没配 api_key 或网关只起了 half）时才退到 `/healthz`。
    const healthy = num(status?.['healthy']) ?? num(health?.['healthy'])
    const total = num(status?.['total']) ?? num(health?.['total'])
    const checkinAccount = pickCheckinAccount(accounts)
    // 面板**只读**：这一段里没有任何会改变状态或花额度的调用。
    return {
      ok: gatewayRead.reachable,
      ...gatewayRead.reachable ? {} : { detail: `网关不可达（${gatewayRead.origin}）：${gatewayRead.detail ?? '未知原因'}` },
      gateway: { reachable: gatewayRead.reachable, origin: gatewayRead.origin, healthy, total },
      credits: status === undefined ? null : buildCredits(accounts, status),
      models: buildModels(gatewayRead.catalog, facts.modelCount),
      provider: { exists: facts.exists, ns: facts.ns, lastOffered: lastOffered ?? null },
      usage: buildUsage(gatewayRead.stats),
      checkin: checkinAccount === undefined
        ? {
            supported: false,
            note: `${CHECKIN_NOTE}（当前没有启用的 CN 账号，签到无法进行）`,
          }
        : { supported: true, note: CHECKIN_NOTE },
    }
  }

  const action = async (body: unknown): Promise<ActionBody> => {
    const request = isDict(body) ? body : {}
    const name = str(request['action'])
    trace(`api: action=${name ?? '(缺失)'}`)
    try {
      if (name === 'rebuild') return describeRebuild(await deps.rebuild())
      if (name === 'checkin') {
        const result = await deps.checkin()
        return { ok: result.ok, attempted: result.attempted, detail: result.detail }
      }
      if (name === 'test') return await runTest(deps, fetchImpl, request, trace)
      return {
        ok: false,
        detail: name === null
          ? '请求体缺少 action（只支持 rebuild / checkin / test）。'
          : `未知 action «${name}»（只支持 rebuild / checkin / test）。`,
      }
    } catch (error) {
      // 动作绝不能把宿主路由带崩：异常折成一条 JSON 回执。
      return { ok: false, detail: `action ${name ?? '?'} 失败：${msg(error)}` }
    }
  }

  return { panel, action }
}

/**
 * `SeedOutcome` → 卡片用的回执。
 *
 * 三个计数字段的**类型是刻意选的**：`addedModels` / `keptModels` / `offeredModels`
 * 都是**数字**（卡片上要的是「保留 46 个，新增 2 个」），具体 id 另给
 * `addedModelIds` / `offeredModelIds` —— 只说个数不够，排障时要看到是哪些 id。
 *
 * ★ 另外还给了 `added` / `addedCount` / `keptCount` / `modelCount` 这几个**别名**：
 * 卡片侧（`lib/client.js` 的 `actRebuild`）按这几个名字读，而两侧是并行开发的。
 * 与其让一边改，不如这一侧多给几个键 —— 多给的键对任何消费者都无害，
 * 缺一个键却会让卡片只剩一句 detail。
 */
function rebuildCounts(added: string[], kept: number, offered: string[], modelCount: number): Record<string, unknown> {
  return {
    addedModels: added.length,
    addedModelIds: added,
    keptModels: kept,
    offeredModels: offered.length,
    offeredModelIds: offered,
    // 兼容别名（见上）。
    added,
    addedCount: added.length,
    keptCount: kept,
    offeredCount: offered.length,
    modelCount,
  }
}

function describeRebuild(outcome: SeedOutcome): ActionBody {
  switch (outcome.kind) {
    case 'rebuilt': {
      const held = outcome.holdReason !== undefined
      return {
        ok: true,
        ...rebuildCounts(outcome.addedModels, outcome.keptModels, outcome.offeredModels, outcome.keptModels + outcome.addedModels.length),
        ns: outcome.ns,
        holdReason: outcome.holdReason ?? null,
        detail: held
          ? `未刷新（${outcome.holdReason}）：保留 ${outcome.keptModels} 个，新增 0 个`
          : `保留 ${outcome.keptModels} 个，新增 ${outcome.addedModels.length} 个`
            + `（settings 条目 ${outcome.ns}）`,
      }
    }
    case 'created':
      return {
        ok: true,
        ...rebuildCounts(outcome.offeredModels, 0, outcome.offeredModels, outcome.modelCount),
        ns: outcome.ns,
        detail: `已创建可编辑 provider：${outcome.modelCount} 个模型（settings 条目 ${outcome.ns}）`,
      }
    case 'present':
      return {
        ok: true,
        ...rebuildCounts([], outcome.modelCount, outcome.offeredModels, outcome.modelCount),
        ns: outcome.ns,
        detail: `provider 已存在（${outcome.modelCount} 个模型），未做任何改动`,
      }
    case 'skipped':
      return {
        ok: false,
        ...rebuildCounts([], 0, [], 0),
        reason: outcome.reason,
        detail: `跳过：${outcome.detail}`,
      }
    case 'rolled-back':
      return {
        ok: false,
        ...rebuildCounts([], 0, [], 0),
        detail: `🔴 写入导致配置丢失，已回滚：${outcome.reasons.join('；')}（备份 ${outcome.backupPath}）`,
      }
    case 'failed':
      return {
        ok: false,
        ...rebuildCounts([], 0, [], 0),
        detail: `🔴 写入失败（${outcome.reason}）：${outcome.detail}`,
      }
  }
}

/**
 * 模型测试：**唯一会花额度的动作**。
 *
 * 三道闸，缺一不可：
 *   ① 请求体必须显式带 `confirm: true` —— 否则**连网关都不碰**；
 *   ② 没指定模型时只用 `credits === 'x0.00'` 的免费档；一个都没有就**拒绝**，绝不替用户挑一个收费的；
 *   ③ `max_tokens` 封顶 64（reasoning 模型思考与回答共用输出预算，给太小会返回**空内容而不是报错**，
 *      所以判据里同时回报 usage，别只看内容）。
 *
 * 花费**报实测值**：调用前后各读一次 `/v1/stats`，用 `credit` 差值回答「这次到底花了多少」。
 */
async function runTest(
  deps: PanelApiDeps,
  fetchImpl: FetchLike,
  request: Record<string, unknown>,
  trace: (line: string) => void,
): Promise<ActionBody> {
  if (request['confirm'] !== true) {
    return {
      ok: false,
      attempted: false,
      detail: '模型测试会真实消耗额度：请在请求体里显式带上 confirm: true（缺了它一步也不会走）。',
    }
  }
  const origin = gatewayOrigin(deps.baseURL)
  const base = deps.baseURL.replace(/\/+$/, '')
  const timeout = Math.max(500, deps.timeoutMs)
  let apiKey: string | undefined
  try {
    apiKey = await deps.resolveApiKey()
  } catch {
    apiKey = undefined
  }
  const catalog = await getJson(fetchImpl, `${base}/models`, apiKey, timeout)
  const entries = (isDict(catalog.body) && Array.isArray(catalog.body['data']) ? catalog.body['data'] : [])
    .filter(isDict)
  const creditOf = (id: string): string | null => {
    const found = entries.find(entry => str(entry['id']) === id)
    return found === undefined ? null : str(found['credits'])
  }

  const explicit = str(request['model'])
  let model: string | undefined = explicit ?? undefined
  let note: string | undefined
  if (model === undefined) {
    const free = entries.find(entry => str(entry['credits']) === FREE_CREDIT_TIER)
    model = str(free?.['id']) ?? undefined
    if (model === undefined) {
      return {
        ok: false,
        attempted: false,
        detail: catalog.ok
          ? `网关目录里没有 ${FREE_CREDIT_TIER} 的免费模型，且请求未指定 model —— `
            + '拒绝替你挑一个收费模型。要测就显式给 model。'
          : `拿不到网关目录（${catalog.error ?? '未知原因'}），无法确定哪个模型免费 —— 要测请显式给 model。`,
      }
    }
    note = `未指定模型，自动选了免费档 ${FREE_CREDIT_TIER} 的 ${model}`
  } else if (creditOf(model) !== FREE_CREDIT_TIER) {
    // 用户点名要测它 —— 尊重，但必须把「单价未知/要花钱」说出来。
    note = creditOf(model) === null
      ? `你指定的 ${model} 在网关目录里没有 credits 字段 ⇒ 单价未知（等于开盲盒）`
      : `你指定的 ${model} 倍率是 ${String(creditOf(model))} —— 会花额度`
  }

  const prompt = str(request['prompt']) ?? 'ping'
  const requestedMax = num(request['maxTokens'])
  const maxTokens = Math.min(64, Math.max(1, Math.floor(requestedMax ?? 16)))

  const statsUrl = `${origin}/v1/stats`
  const before = await getJson(fetchImpl, statsUrl, apiKey, timeout)
  const started = Date.now()
  let status = 0
  let payload: unknown
  let failure: string | undefined
  try {
    const response = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...apiKey !== undefined && apiKey !== '' ? { authorization: `Bearer ${apiKey}` } : {},
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, stream: false }),
      signal: AbortSignal.timeout(Math.max(1000, deps.chatTimeoutMs ?? 60_000)),
    })
    status = response.status
    const text = await response.text().catch(() => '')
    try {
      payload = text === '' ? undefined : JSON.parse(text)
    } catch {
      payload = undefined
      failure = `响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`
    }
    if (failure === undefined && !response.ok) failure = `HTTP ${response.status}：${text.slice(0, 200)}`
  } catch (error) {
    failure = msg(error)
  }
  const ms = Date.now() - started
  const after = await getJson(fetchImpl, statsUrl, apiKey, timeout)

  const record = isDict(payload) ? payload : {}
  const choices = Array.isArray(record['choices']) ? record['choices'] : []
  const first = isDict(choices[0]) ? choices[0] : {}
  const message = isDict(first['message']) ? first['message'] : {}
  const content = str(message['content']) ?? ''
  const totalCredit = (read: JsonRead): number | null => {
    const body = isDict(read.body) ? read.body : undefined
    const total = isDict(body?.['total']) ? body['total'] : undefined
    return num(total?.['credit'])
  }
  const creditBefore = totalCredit(before)
  const creditAfter = totalCredit(after)
  const creditSpent = creditBefore !== null && creditAfter !== null ? creditAfter - creditBefore : null
  trace(`api: test model=${model} status=${status} ms=${ms} credit=${creditSpent === null ? '?' : String(creditSpent)}`)

  if (failure !== undefined) {
    return {
      ok: false,
      attempted: true,
      model,
      status,
      ms,
      results: [{ id: model, model, ok: false, verdict: failure, detail: failure, status, ms }],
      detail: `模型测试失败：${failure}`,
      ...note !== undefined ? { note } : {},
    }
  }
  const verdict = content === ''
    ? 'HTTP 通了但内容为空（reasoning 模型思考与回答共用输出预算，maxTokens 太小就会这样，不是报错）'
    : `HTTP ${status} · ${ms}ms · 实际花费 ${creditSpent === null ? '未测到（/v1/stats 不可用）' : String(creditSpent)}`
  return {
    ok: true,
    attempted: true,
    model,
    status,
    ms,
    maxTokens,
    content: content.slice(0, 500),
    contentEmpty: content === '',
    usage: isDict(record['usage']) ? record['usage'] : null,
    creditBefore,
    creditAfter,
    creditSpent,
    // `results[]` 是卡片逐行渲染用的形状（每行一个模型：`id · verdict`）。
    results: [{ id: model, model, ok: true, verdict, detail: verdict, status, ms, contentEmpty: content === '' }],
    detail: verdict,
    ...note !== undefined ? { note } : {},
  }
}

/* ── 传输面：宿主 web 路由 ────────────────────────────────────────────────── */

interface RouteRequest {
  method?: string
  url?: string
  headers?: Record<string, unknown>
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>
}

interface RouteResponse {
  writeHead: (code: number, headers?: Record<string, string>) => void
  end: (body?: string) => void
}

/** 读一个请求头（Node 的 `req.headers` 是小写键的普通对象）。 */
function headerOf(req: unknown, name: string): string | undefined {
  const headers = (req as { headers?: Record<string, unknown> } | undefined)?.headers
  if (headers === undefined || headers === null || typeof headers !== 'object') return undefined
  const value = (headers as Record<string, unknown>)[name]
  return typeof value === 'string' ? value : undefined
}

/** 回环主机名，写法与 `dsh-client-connection` 逐字一致。 */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

/**
 * 栅栏的「回环端口跳转」例外 —— 与兄弟插件（`dsh-subagent-router` / `dsh-trae`）
 * **同一口径，绝不更严**。
 *
 * 现场：桌面 app 的界面层把请求转给宿主时 **Host 换成宿主端口、Origin 仍是 app 端口**，
 * 而框架的 `isTrustedApiRequest` 要求 `new URL(origin).host === host`（含端口）⇒ 必然 403。
 * 判得比兄弟插件严的后果是**自己把自己挡死**（Trae 为此查了两天）。
 *
 * 只放宽「Host 与 Origin 两边都是回环」这一种（端口可不同）：
 *   · 非回环 Host（`evil.example.com` / `0.0.0.0`）仍然拒绝；
 *   · 非回环 Origin（`file://` / 外部站点）仍然拒绝；
 *   · **401 永不放宽** —— 那是「你不是操作者」（浏览器会话缺失/过期），不是端口跳转。
 */
export function isLoopbackPortHop(req: unknown): boolean {
  const host = headerOf(req, 'host')
  if (host === undefined) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostname)) return false
  const origin = headerOf(req, 'origin')
  if (origin === undefined) return true
  try {
    return isLoopbackHostname(new URL(origin).hostname)
  } catch {
    return false
  }
}

/** 那条放宽只记一次：它是「卡片怎么被送达」的事实，不是每请求一次的事件。 */
let portHopToleratedLogged = false

async function readRouteBody(req: RouteRequest): Promise<string> {
  const iterate = req[Symbol.asyncIterator]
  if (typeof iterate !== 'function') return ''
  let size = 0
  const chunks: string[] = []
  for await (const chunk of req as AsyncIterable<unknown>) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
    size += Buffer.byteLength(text, 'utf8')
    if (size > ROUTE_BODY_LIMIT) throw new Error('请求体过大')
    chunks.push(text)
  }
  return chunks.join('')
}

/** {@link createHostRouteHandler} 的注入点。 */
export interface HostRouteDeps {
  /**
   * 宿主自己的栅栏 `connection.requestRejection`（Host/Origin + 浏览器会话）。
   * **必需** —— 没有栅栏就不能服务：「无鉴权的路由」严格劣于「没有路由」。
   */
  requestRejection: (req: unknown) => number | undefined
  /** 两个端点的实现（见 {@link createPanelApi}）。 */
  api: PanelApi
  /** 轨迹锚点（缺省丢弃）。 */
  trace?: (line: string) => void
}

const ESCAPED_PREFIX = ROUTE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ESCAPED_API_PREFIX = API_ROUTE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 剥掉命中的那条前缀。
 *
 * 两条前缀都要求**边界**（`/` 或串尾）：`/api` 只在后面确实跟着我们的路径时才剥，
 * 裸前缀同理 —— 否则 `/wb2apix/panel` 会被剥成 `x/panel` 落到我们头上。
 * （`webServer` 的前缀表本身就带边界，所以这是第二道闸，不是唯一一道。）
 */
export function stripRoutePrefix(pathname: string): string {
  const boundary = '(?=/|$)'
  return pathname
    .replace(new RegExp(`^${ESCAPED_API_PREFIX}(?=${ESCAPED_PREFIX}${boundary})`), '')
    .replace(new RegExp(`^${ESCAPED_PREFIX}${boundary}`), '')
}

/**
 * 造出宿主路由的 handler。
 *
 * 做成工厂（而不是内联在 `ctx.inject` 回调里）是为了能**用真 HTTP 在进程内驱动它**：
 * 前缀剥离、栅栏、两条前缀的等价性都是断言而不是希望。
 *
 * @param deps - 栅栏与两个端点的实现。
 * @returns `(req, res) => Promise<void>`（Node 的裸 http，`req.url` 不被改写）。
 */
export function createHostRouteHandler(deps: HostRouteDeps): (req: unknown, res: unknown) => Promise<void> {
  const trace = deps.trace ?? ((): void => {})
  return async (req: unknown, res: unknown): Promise<void> => {
    const request = req as RouteRequest
    const response = res as RouteResponse
    const write = (status: number, body: Record<string, unknown>): void => {
      const payload = JSON.stringify(body)
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(payload, 'utf8')),
        'Cache-Control': 'no-store',
      })
      response.end(payload)
    }

    // ① 栅栏：口径与兄弟插件逐字一致（含那条唯一被容忍的 403）。
    let rejection: number | undefined
    try {
      rejection = deps.requestRejection(request)
    } catch (error) {
      // 栅栏自己抛了 —— 按拒绝处理（与兄弟插件同一处置），但**必须留痕**：
      // 「栅栏说 403」与「栅栏抛了异常被我按 403 处理」在排障时是两件完全不同的事，
      // 而下面那条容忍分支会把 403 变成放行，不说清楚就再也看不出来。
      rejection = 403
      trace(`api: 栅栏 requestRejection 抛错，按 403 处理 —— ${msg(error)}`)
    }
    if (rejection !== undefined && !(rejection === 403 && isLoopbackPortHop(request))) {
      // 与兄弟插件一样回**纯文本**（不是 JSON）：客户端据此区分「栅栏拒绝」与
      // 「端点答了」，进而换另一条前缀重试。
      trace(`api: 路由被栅栏拒绝 ${rejection}（host=${headerOf(request, 'host') ?? '(无)'} `
        + `origin=${headerOf(request, 'origin') ?? '(无)'}）`)
      response.writeHead(rejection, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    if (rejection === 403 && !portHopToleratedLogged) {
      portHopToleratedLogged = true
      trace(`api: 栅栏 403 按回环端口跳转容忍（host=${headerOf(request, 'host') ?? '?'} `
        + `origin=${headerOf(request, 'origin') ?? '?'}）—— 卡片是经桌面 app 的代理送达的`)
    }

    // ② 路由。`req.url` 是裸 http 的原始串（不被改写），前缀要自己剥。
    const method = (typeof request.method === 'string' ? request.method : 'GET').toUpperCase()
    let pathname: string
    try {
      pathname = new URL(typeof request.url === 'string' ? request.url : '/', 'http://127.0.0.1').pathname
    } catch {
      write(404, { ok: false, detail: `无法解析的请求路径：${String(request.url)}` })
      return
    }
    const relative = stripRoutePrefix(pathname)
    const route = relative.length > 1 ? relative.replace(/\/+$/, '') : relative

    try {
      if (route === '/panel') {
        if (method !== 'GET' && method !== 'HEAD') {
          write(405, { ok: false, detail: `${ROUTE_PREFIX}/panel 只接受 GET。` })
          return
        }
        write(200, await deps.api.panel() as unknown as Record<string, unknown>)
        return
      }
      if (route === '/action') {
        if (method !== 'POST') {
          write(405, { ok: false, detail: `${ROUTE_PREFIX}/action 只接受 POST。` })
          return
        }
        let body: unknown
        try {
          const raw = await readRouteBody(request)
          body = raw === '' ? {} : JSON.parse(raw)
        } catch (error) {
          // 与兄弟插件同一口径：解析失败是 **200 + ok:false**，不是 400 ——
          // 卡片那侧只需看 ok，不必再学一套状态码语义。
          write(200, { ok: false, detail: `请求体不是合法 JSON：${msg(error)}` })
          return
        }
        write(200, await deps.api.action(body))
        return
      }
      write(404, {
        ok: false,
        detail: `未知端点 ${route}（本插件只有 ${ROUTE_PREFIX}/panel 与 ${ROUTE_PREFIX}/action）。`,
      })
    } catch (error) {
      // 端点自己已经不抛了，这是最后一张网：任何异常都不该变成一句无正文的 500。
      write(200, { ok: false, detail: msg(error) })
    }
  }
}

/* ── 注册（找服务、挂两条前缀、配对反注册） ───────────────────────────────── */

/**
 * 注册用得着的那几样服务，**只声明真实用到的方法**。
 *
 * 这样这个函数就能用一个替身对象驱动（单测里不需要真 cordis），而真实的
 * `Context` 在结构上满足它。
 */
export interface PanelRouteContext {
  /** 注入 `['connection','webServer']`（回调**会重跑**，所以必须配对反注册）。 */
  inject?: (deps: string[], callback: (ctx: unknown) => void) => unknown
  /** 反注册的载体。 */
  effect?: (execute: () => () => void, label?: string) => unknown
  /** `ctx.get(name)` 兜底读法（宿主自己的插件就是两种读法都写了）。 */
  get?: (name: string) => unknown
  /** 栅栏（`connection.requestRejection`）。 */
  connection?: { requestRejection?: (req: unknown) => number | undefined }
  /** 前缀路由表（`webServer.register`）。 */
  webServer?: { register?: (route: unknown) => unknown }
}

/** {@link registerPanelRoutes} 的注入点。 */
export interface RegisterPanelRoutesOptions {
  /** 两个端点的实现（**在多次重注册之间复用同一个**：它是无状态的）。 */
  api: PanelApi
  /** 轨迹锚点。 */
  trace?: (line: string) => void
}

/**
 * 在宿主 web 服务器上挂上本插件的两条前缀，并配好反注册。
 *
 * 与 `dsh-trae`/`dsh-subagent-router` **逐条同构**（那两份是实测过的）：
 *   · 必须**连 `connection` 一起 inject** —— 只 inject `webServer` 拿不到栅栏；
 *   · `register({kind:'prefix', path, handler})` 返回**同步 disposer**（也可能是 Promise）；
 *   · 每一个 `register` 都套**单条 try**：一条抛错不能让整组死掉；
 *   · 两条前缀：`/wb2api` 与 `/api/wb2api`（桌面 app 只转 `/api/*`）；
 *   · 最后 `ctx.effect(() => () => disposers.forEach(d => d()))` —— 不配对反注册，
 *     inject 回调重跑时 `register` 会因为重复的 `(kind, path)` 直接抛。
 *
 * ★ **唯一一处刻意与它们不同**：栅栏以**方法形式**调用（见下面那段注释）。它们把方法摘成
 * 裸函数再调，实测会让栅栏永远抛错并被 403 容忍吞掉 —— 那等于把「无凭据请求」放行。
 *
 * @param ctx - 插件自己的 context（`apply(ctx, …)` 的那个）；它会在这里 `inject` 两个服务。
 * @param options - 端点实现与轨迹。
 * @returns 无。拿不到服务时留一行轨迹就返回（**绝不让插件加载失败**）。
 */
export function registerPanelRoutes(ctx: PanelRouteContext, options: RegisterPanelRoutesOptions): void {
  const trace = options.trace ?? ((): void => {})
  if (typeof ctx.inject !== 'function') {
    trace('api: ctx.inject 不可用 —— 路由未注册（设置卡片没有数据）')
    return
  }
  ctx.inject(['connection', 'webServer'], (child: unknown) => {
    const routeCtx = child as PanelRouteContext
    const fromProperty = routeCtx as unknown as {
      connection?: { requestRejection?: (req: unknown) => number | undefined }
      webServer?: { register?: (route: unknown) => unknown }
    }
    const connection = fromProperty.connection
      ?? (typeof routeCtx.get === 'function' ? routeCtx.get('connection') as typeof fromProperty.connection : undefined)
    const webServer = fromProperty.webServer
      ?? (typeof routeCtx.get === 'function' ? routeCtx.get('webServer') as typeof fromProperty.webServer : undefined)
    const register = webServer?.register
    const requestRejection = connection?.requestRejection
    if (typeof register !== 'function' || typeof requestRejection !== 'function') {
      trace(
        `api: 路由未注册 —— ${typeof register !== 'function' ? 'webServer.register' : 'connection.requestRejection'} 不可用；`
        + '设置卡片将没有数据（「没有路由」优于「没有栅栏的路由」）。网关托管、命令与可编辑 provider 都不受影响。',
      )
      return
    }
    // ★ 栅栏必须**以方法形式**调用（`connection.requestRejection(req)`），不能把方法摘下来
    // 变成裸函数再调。cordis 的服务是 Proxy（`createTraceable` + `createShadowMethod`），
    // 摘下来调用会让 `this` 落到一个没有 `browserAuth` 的影子上 —— 实测报
    //   `Cannot read properties of undefined (reading 'isAuthenticated')`
    // 于是栅栏永远抛错、永远被当成 403，浏览器会话那一半**根本没跑**。
    // 详见 `_wb2api-route-verify/` 里的真机探针（probe.mjs 的 A/B/C/D 变体）。
    const fence = connection as { requestRejection: (request: unknown) => number | undefined }
    const handler = createHostRouteHandler({
      requestRejection: (request: unknown) => fence.requestRejection(request),
      api: options.api,
      trace,
    })

    const disposers: (() => void)[] = []
    for (const path of ROUTE_PATHS) {
      try {
        const registered = register.call(webServer, { kind: 'prefix', path, handler })
        if (typeof registered === 'function') disposers.push(registered as () => void)
        else if (registered !== null && typeof (registered as Promise<unknown>)?.then === 'function') {
          // 返回值也可能是 `Promise<disposer>`（两代内核都见过）—— 两种都要接。
          const pending = registered as Promise<unknown>
          disposers.push(() => {
            void pending
              .then((dispose) => { if (typeof dispose === 'function') (dispose as () => void)() })
              .catch(() => undefined)
          })
        }
      } catch (error) {
        // 单条 try：一条挂了（前缀被别人占了）不影响另一条。
        trace(`api: ${path} 注册失败 — ${msg(error)}`)
      }
    }
    if (disposers.length === 0) {
      trace('api: 一条前缀都没挂上 —— 设置卡片没有数据通道（其余功能不受影响）')
      return
    }

    if (typeof routeCtx.effect !== 'function') {
      // 没有 effect 就没有反注册手段 —— 与其挂上一条**撤不掉**的路由（下次重跑必抛），
      // 不如现在就把它们摘掉，并如实说明。
      trace('api: ctx.effect 不可用 —— 路由已撤回（无法反注册的路由会在 inject 重跑时抛错）')
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已经没了 */
        }
      }
      return
    }
    routeCtx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已经没了 */
        }
      }
    }, 'workbuddy2api: panel routes')
    trace(`api: 已注册 ${ROUTE_PATHS.join(' 与 ')}（${disposers.length} 条前缀 · handler=createHostRouteHandler）`)
  })
}
