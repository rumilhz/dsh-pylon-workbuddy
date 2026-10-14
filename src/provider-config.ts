/**
 * 生成「设置 → 模型 → 供应商」里那份**可编辑**的 provider 配置，并且**只在它缺失时**
 * 创建一次。
 *
 * ## 为什么写进 `llm-pi-ai` 的 Config，而不是注册插件自带路由
 *
 * 「设置 → 模型」页本质是**配置文件编辑器**：`dsh-client-ui-settings-models` 只给
 * `llm-deepseek` / `llm-pi-ai` 两个 settings namespace 渲染模型编辑器，而 provider
 * 行只在 `configured === true` 时出现。插件用
 * `ctx.llm.registerConfigurableProviders()` 注册的路由是**代码注册的运行时路由**，
 * 它的 namespace 不在 profile 里，因此永远是「不可编辑」的第二行；它的模型目录直接
 * 来自 `/v1/models`，又会绕过操作员在设置页做的筛选。
 *
 * 把目录**落成** `llm-pi-ai.providers.<name>` 就没有这两个问题：同一个 provider 既
 * 是路由，又是设置页里可增删改的那一份，聊天选择器与子代理路由读到的都是它。
 *
 * ## 只创建，绝不改写
 *
 * 判定是**存在即什么都不做**（连元数据刷新都不做）。理由：操作员会在模型页把自动
 * 生成的整份清单删到他真正要用的那几个，任何「自动补齐 / 自动同步」都会把他删掉的
 * 模型重新塞回来 —— 那是这套逻辑最不能犯的错。插件升级也一样：新版本同样只走这一
 * 条「存在即返回」的路径，不会碰他已经筛过的清单。
 *
 * 想看「网关现在多出哪些模型」用只读的 {@link diffProviderModels}
 * （`/wb2api-provider` 命令），它只打印差异、**不写任何东西**。
 *
 * ## 字段从哪来，以及为什么允许缺
 *
 * 每个模型的 `contextWindow` / `maxTokens` 直接取网关 `/v1/models` 的
 * `context_length` / `max_output_tokens`，**不做任何兜底**：pi-ai 对缺失的
 * `contextWindow` 会静默套用 262144（`dsh-llm-pi-ai/lib/index.js:675`，
 * `DEFAULT_CONTEXT_WINDOW` 在 `:927`），套错了比缺字段更危险。网关没说就不写，
 * 并把「哪些模型缺哪个字段」原样报出来，让操作员自己在模型页补。
 *
 * `reasoningEfforts` 是 `{档位: 线上值}` 字典，写进去的线上值会被 pi-ai 原样塞进
 * 请求体的 `reasoning_effort`（`@earendil-works/pi-ai/dist/api/openai-completions.js:712-715`
 * 的默认 OpenAI 分支）。本仓库自己的适配器对同一个网关发的也是同一个字段、同一个
 * 值（`src/gateway-adapter.ts:391-394`），所以这里用**恒等映射**（`high: high`）。
 *
 * ## 失败时的姿态
 *
 * 写入用 settings API 的 `mutate(ns, [{op:'set', path:['providers', name], value}])`，
 * 它在落盘前会跑一遍 `resolveConfig(fiber.runtime, next)` 校验。
 * 任何一步失败都不抛给 dsh 启动流程，而是返回一份**可直接粘贴的 YAML**并说清贴到哪 ——
 * 插件的立场是「让问题可见」，不是「让 dsh 起不来」。注意插件**不会**删除或改动任何
 * 既有 provider：失败时系统停在「路由指向一个不存在的 provider」这个**本来就存在**的
 * 状态上，插件只负责把它说清楚并给出修法。
 *
 * ## 为什么 `configEditor` 自带的回滚还不够（安全网的由来）
 *
 * `dsh-config-editor` 确实会回滚：写入前先读一份 `before`，调和失败时用 `before`
 * 盖回去（`lib/index.js:84-90, 123-130`）。但那个回滚**只覆盖"调和抛错"这一种失败**。
 * 2026-10-08 的事故是另一种：`mutate` **返回了成功**，而 profile patch 已经从
 * 34 条目 / 63,570 B 变成 3 条目 / 661 B —— 没有异常、没有回滚、插件还报告了"已创建"。
 *
 * 所以这一层必须自己再确认一次，这就是 {@link WriteGuard} 存在的理由：
 *   · 写前把整份 patch 备份到 **profile 之外**（铁律 ①）；
 *   · 写后**独立读回磁盘**核对条目数（铁律 ②）；
 *   · 条目少了立刻把备份盖回去（铁律 ③）。
 *
 * 判定与恢复的实现见 `write-guard.ts`；判定规则本身是纯函数，因为它恰恰是
 * "只在事故当天才起作用、因而最容易悄悄退化"的那部分。
 *
 * @module dsh-workbuddy2api/provider-config
 */

import type { GatewayCatalogEntry } from './models.js'

/**
 * 写进 provider 配置的**线协议**。
 *
 * 网关的 `/v1/chat/completions` 说 OpenAI 的 completions 方言，管理员的
 * `llm-pi-ai.providers.workbuddy` 手写块也写的是它。pi-ai 里 `api` **只有路由级**
 * （没有 per-model 的 api 字段），所以这是整个 provider 的协议选择。
 */
export const GATEWAY_WIRE_API = 'openai-completions'

/**
 * pi-ai 认识的思考档位（`dsh-llm-pi-ai/lib/index.js:296-304` 的 `THINKING_LEVELS`）。
 *
 * 它是 `reasoningEfforts` 字典的**键**的枚举：网关若哪天报出一个集合外的档位，
 * 直接写进去会让整个 `mutate` 校验失败（连带这次创建一起失败），所以这里过滤掉
 * 并在报告里点名，而不是让它把整件事拖垮。
 */
export const THINKING_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 路由级重试策略，与管理员手写块（`cordis.patch.yml` 的 `workbuddy` 段）一致。
 *
 * `maxRetries: 0` 不是笔误：故障转移由网关自己按账号池做，客户端再重试只会把
 * 一次上游抖动放大成多次计费请求。这一项是 `profile` schema 里的可选项，写出来是
 * 为了**让它在模型页可见、可改**，而不是为了改变默认行为。
 */
export const GATEWAY_RETRY_POLICY = { mode: 'normal', maxRetries: 0 } as const

/** dsh-settings `describe()` 返回的一项（只声明本模块用到的成员）。 */
export interface SettingsDescriptor {
  /** profile 条目 id，也就是 settings namespace。 */
  ns: string
  /** 描述时的修订号；写入时回传可拿到冲突检测。 */
  revision?: number
  /** volatile 表单的 schema JSON。 */
  schema?: unknown
  /** 生效值（继承层 + profile 覆盖层解析后的结果）。 */
  value?: unknown
  /** 继承层值。 */
  base?: unknown
  /** profile 覆盖层（用户手写的那份）。 */
  user?: unknown
}

/**
 * settings 服务的最小面。
 *
 * 刻意只声明本模块真正调用的两个成员：dsh 的内核版本会漂移，`settings` 服务在
 * 老版本里根本没有 `mutate`，缺任何一个都只是**降级成「打印手工块」**，不该让
 * 插件加载失败。
 */
export interface SettingsServiceLike {
  describe?: (options?: { redactSecrets?: boolean }) => SettingsDescriptor[]
  mutate?: (ns: string, ops: SettingsPathOp[], expectedRevision?: number) => Promise<void>
}

/** settings 表单路径操作（`mutate` 的入参元素）。 */
export interface SettingsPathOp {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

/** 解析出的目标 namespace 与其 providers 字典。 */
export interface ProviderNamespace {
  /** profile 条目 id。 */
  ns: string
  /** 描述时的修订号，用于写入冲突检测；`describe()` 没给就是 undefined。 */
  revision: number | undefined
  /** 生效值里的 `providers` 字典（没有则是空对象）。 */
  providers: Record<string, unknown>
  /** 所有「根级 providers 是 dict」的候选 namespace，供日志说明探测过程。 */
  candidates: string[]
}

/** 生成出来的一条模型配置。缺失的字段**整体不出现**，不去猜。 */
export interface ProviderModelProfile {
  /** 网关原始 id（含 `cn:` / `global:` 前缀）。 */
  id: string
  /** 网关透出的展示名。 */
  name?: string
  /** 上下文窗口（来自 `context_length`）。 */
  contextWindow?: number
  /** 输出上限（来自 `max_output_tokens`）。 */
  maxTokens?: number
  /** 输入模态；`supports_images` 缺席即仅文本（与 `models.ts` 同一口径）。 */
  input: string[]
  /** 档位 → 线上值；网关没声明档位时不出现。 */
  reasoningEfforts?: Record<string, string>
}

/** 生成出来的整个 provider 段。 */
export interface ProviderProfile {
  apiKeyEnv: string
  api: string
  baseURL: string
  retryPolicy: { mode: string; maxRetries: number }
  models: ProviderModelProfile[]
}

/** 一条模型在生成时被略过/改写的字段（用来把「缺什么」说实话，而不是补一个假值）。 */
export interface ProviderModelNote {
  id: string
  /** 网关没下发、因而**没有**写进配置的字段。 */
  absent: string[]
  /** 网关报出的、但不在 pi-ai 档位枚举内、因而被丢弃的档位。 */
  droppedEfforts: string[]
  /** 网关名单里重复出现、被折叠掉的次数。 */
  duplicateOf?: string
}

/** {@link buildProviderProfile} 的结果。 */
export interface ProviderProfileBuild {
  profile: ProviderProfile
  notes: ProviderModelNote[]
}

/** 生成参数。 */
export interface BuildProviderProfileOptions {
  /** 写进配置的凭据 ref 名（`apiKeyEnv`）。 */
  apiKeyEnv: string
  /** 网关端点根。 */
  baseURL: string
}

/** 只读差异（`/wb2api-provider` 用，永远不写）。 */
export interface ProviderModelDiff {
  /** 网关现在有、配置里没有的模型 id。 */
  missingFromProfile: string[]
  /** 配置里有、网关现在没有的模型 id（下架或改名）。 */
  unknownToGateway: string[]
  /** 两边都有、但上下文窗口或输出上限不同的模型。 */
  drifted: Array<{ id: string; field: 'contextWindow' | 'maxTokens'; configured: number; gateway: number }>
}

/** 日志面（`ctx.logger` 的结构子集）。 */
export interface ProviderSeedLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/**
 * 写路径安全网（实现见 `write-guard.ts`，由 `index.ts` 接线）。
 *
 * 之所以在这里**只声明接口**、把实现留在外面：`seedEditableProvider` 的既有取舍是
 * 「不建 cordis 树、不连真网关」，只为了写一个 provider 就把文件系统拖进这一层，
 * 会让那层单测失去意义。接口留在这里，事故当天真正要生效的那三条决策
 * （备份失败就放弃、条目变少就回滚、读不回来当异常）仍然可以在这一层被断言。
 *
 * **`guard` 缺席时 {@link seedEditableProvider} 拒绝写入**（降级成"打印手工块"）。
 * 规矩是"任何写用户配置的能力，没有安全网不许上 live"，不是"没有安全网就裸写"。
 */
export interface WriteGuard {
  /** 写前备份并记录基线。**抛错表示备份失败 ⇒ 调用方必须放弃写入。** */
  snapshot(): Promise<WriteBaseline>
  /** 写后读回判定。 */
  verify(baseline: WriteBaseline, expected: { modelCount: number }): Promise<WriteVerdict>
  /** 判定异常时把配置恢复回去。 */
  rollback(baseline: WriteBaseline): Promise<void>
}

/** 写入前的基线（结构上与 `write-guard.ts` 的 `WriteGuardSnapshot` 一致）。 */
export interface WriteBaseline {
  /** 备份文件的绝对路径（**在 profile 之外**）。 */
  backupPath: string
  /** 写入前 patch 里的条目数。 */
  entryCount: number
  /** 写入前 patch 的字节数。 */
  bytes: number
}

/** 写后判定。 */
export type WriteVerdict =
  | { ok: true }
  | { ok: false; reasons: string[] }

/** {@link seedEditableProvider} 的依赖。 */
export interface SeedDeps {
  /** settings 服务；缺失即降级。 */
  settings: SettingsServiceLike | undefined
  /** `providers.<name>` 的键名。 */
  providerName: string
  /** 显式指定的 namespace；空串表示探测。 */
  preferredNamespace: string
  /** 写进配置的凭据 ref 名。 */
  apiKeyEnv: string
  /** 网关端点根。 */
  baseURL: string
  /** 拉原始目录；抛错表示网关不可达。**只在 provider 缺失时才会被调用。** */
  fetchEntries: () => Promise<GatewayCatalogEntry[]>
  /** 探测 namespace 的重试次数（等 Loader 把 profile 条目激活）。 */
  namespaceAttempts?: number
  /** 探测 namespace 的间隔（毫秒）。 */
  namespaceIntervalMs?: number
  /** 拉目录的重试次数（等网关起来）。 */
  catalogAttempts?: number
  /** 拉目录的间隔（毫秒）。 */
  catalogIntervalMs?: number
  /**
   * provider **已存在**时是否也去网关对一遍清单。
   *
   * · `false` / 缺省 —— 「存在即返回，绝不改写」。这是本模块的核心不变量：
   *   操作员在模型页删掉的模型**绝不能**被自动补回来。
   * · `true` —— 显式刷新（`/wb2api-provider --rebuild`）。**只有操作员当场敲下
   *   这个开关**才会走到这里，插件自己永远不会主动选它。
   *
   * `true` 时走的是**只增不删**：`added = 网关目录 − 配置里已有的 − 墓碑里的`，
   * 写回的是「你现有的条目**原样** + added」。所以它**不会**复活被删掉的模型，
   * 代价是它依赖 {@link SeedDeps.readOffered} 那条记忆（没有记录时保守地什么都不加）。
   *
   * 字段名保留 `overwrite` 是为了不破坏既有接线；它现在的语义是「刷新」，
   * 不再是「整份覆盖」。
   */
  overwrite?: boolean
  /**
   * 读「上次提供过哪些模型 id」（墓碑集合）。
   *
   * · `undefined` 返回值 —— **没有记录**（文件不存在 / 读坏了 / 从来没写过）。
   *   与「记录是空数组」不同义：前者是「不知道」，后者是「知道，一个都没提供过」。
   * · 不接线 / 抛错 —— 同样按「没有记录」处理，于是 `--rebuild` 保守地**什么都不加**
   *   （见 {@link SeedOutcome} 的 `holdReason`）。
   *
   * 这条记忆是「只增不删」能成立的**唯一**依据：少了它，"网关有而配置里没有"
   * 就永远分不清是「新增」还是「你删掉的」。
   */
  readOffered?: () => Promise<string[] | undefined>
  /**
   * 把「迄今提供过的并集」写回墓碑（下一轮的判据）。
   *
   * **调用时机是严格的**：`present` / `created` / `rebuilt`（真写了，或本来就没有
   * 记录需要先立个基线）才会被调用；`skipped` / `failed` / `rolled-back` **绝不**调用
   * —— 写失败、回滚、连 settings 都没有的时候，不能让墓碑替一次没发生的写背书记录。
   *
   * 它**抛错不影响 provider 写入的结果**：调用方会捕获并在结果的 `stateWarning`
   * 里注明。墓碑是我们自己的账本，账本丢了可以重记，配置丢了不行。
   */
  writeOffered?: (ids: string[]) => Promise<void>
  /**
   * 写路径安全网。**缺席即拒绝写入**（降级成"返回手工块"）。
   *
   * 可选而不是必填，是为了让"没接线"这件事在类型上表达得出来、并被显式拒绝，
   * 而不是编译期一过就悄悄裸写。
   */
  guard?: WriteGuard
  /** 注入 sleep，便于测试。 */
  sleep?: (ms: number) => Promise<void>
}

/**
 * {@link seedEditableProvider} 的结果。调用方负责把它渲染成日志/命令输出。
 *
 * `present` / `created` / `rebuilt` 三个分支都会带上 `offeredModels`
 * （迄今提供过的并集 = 下一轮的墓碑全集），调用方把它原样写回状态文件即可。
 */
export type SeedOutcome =
  | {
    kind: 'present'
    ns: string
    modelCount: number
    /**
     * 迄今提供过的并集。
     *
     * 有记录时 = 上一轮墓碑 ∪ 当前配置里的 id；**没有记录时 = 当前配置里的 id，
     * 但那一条不会落盘**（见 `offeredRecorded`）。
     */
    offeredModels: string[]
    /**
     * 本次有没有把墓碑写进去。
     *
     * `false` 只有一种情形：**本来就没有记录**。此时刻意不从零造一条（用当前配置
     * 当基线会复活用户在这个版本之前删掉的模型），留给下一次 `--rebuild` 按
     * 「没有记录」的保守规则处理。
     */
    offeredRecorded: boolean
    /** 墓碑没能写回时的说明；provider 配置本身一个字都没动。 */
    stateWarning?: string
  }
  | {
    kind: 'created'
    ns: string
    modelCount: number
    notes: ProviderModelNote[]
    /** 迄今提供过的并集（本轮 = 写进去的全部 id ∪ 上一轮墓碑）。 */
    offeredModels: string[]
    /** 墓碑没能写回时的说明；provider 已经写成功了。 */
    stateWarning?: string
  }
  /**
   * 显式刷新：provider 已存在，操作员用 `--rebuild` 要求去网关对一遍。
   *
   * **只增不删** —— `keptModels` 那些条目原样留在配置里，一个都不删。
   * 与 `created` 分开是刻意的：这两件事的**代价**完全不同 —— `created` 是在空位上
   * 新建，`rebuilt` 动的是操作员已经筛过一遍的清单。
   */
  | {
    kind: 'rebuilt'
    ns: string
    /** 本次真正写进条目的新 id（既不在配置里、也不在墓碑里）。没有新增时是空数组。 */
    addedModels: string[]
    /** **写入前**配置里已有的模型个数。★ 是数字，不是数组（渲染层要的是「保留 N 个」）。 */
    keptModels: number
    /** 迄今提供过的并集 = 下一轮的墓碑全集。 */
    offeredModels: string[]
    /** 备份落点；**本次没有写入时为 undefined**（没写就没有备份）。 */
    backupPath?: string
    /** 只针对本次新增的那些模型的字段说明。 */
    notes: ProviderModelNote[]
    /**
     * 有值时说明本轮为什么**故意一个都没加**。
     *
     * 当前只有一种情形：没有上一次的墓碑记录，因此无法区分「网关新增」与
     * 「你删掉的」—— 此时**不添加任何东西**是唯一不会复活已删模型的选择。
     */
    holdReason?: string
    /** 墓碑没能写回时的说明；provider 配置的写入结果不受影响。 */
    stateWarning?: string
  }
  | { kind: 'skipped'; reason: 'no-settings-service' | 'no-namespace'; detail: string }
  /**
   * 写入**返回了成功**，但读回校验判定不可信，配置已按备份恢复。
   *
   * 这个分支的存在本身就是这次改造的要点：过去这种情形会一路走到 `created`，
   * 把"写坏了"报告成"写好了"。它必须是一个**显眼的独立结果**，而不是某个
   * `failed` 的 reason —— 操作员看到它时要知道"刚才差点出事，已经挡住了"。
   */
  | {
    kind: 'rolled-back'
    ns: string
    /** 判定不可信的原因（逐条列出）。 */
    reasons: string[]
    /** 备份落点（已经盖回去了，留档备查）。 */
    backupPath: string
    /** 回滚本身的结果；回滚失败时这里会给出手工命令。 */
    recovery: string
    manualBlock: string
    notes: ProviderModelNote[]
  }
  | {
    kind: 'failed'
    reason: 'gateway-unreachable' | 'write-failed'
    detail: string
    /** 可直接粘贴进 profile `cordis.patch.yml` 的 YAML；拿不到目录时为 undefined。 */
    manualBlock?: string
    notes: ProviderModelNote[]
  }

/** 默认探测节奏：namespace 快而密（等 Loader），目录慢而疏（等网关）。 */
const DEFAULT_NAMESPACE_ATTEMPTS = 40
const DEFAULT_NAMESPACE_INTERVAL_MS = 250
const DEFAULT_CATALOG_ATTEMPTS = 5
const DEFAULT_CATALOG_INTERVAL_MS = 1500

/**
 * 手工粘贴块的缩进（6 空格）。
 *
 * 对应 `cordis.patch.yml` 里 `- id: llm-pi-ai` → `config:` → `providers:` 之下那一层：
 * 条目在序列里缩进 2，`config` 缩进 4，`providers` 缩进 6，provider 名与 `providers`
 * 同级。粘错层级的 YAML 不会报错，只会被当成另一个字段静默忽略 —— 所以这个数字
 * 必须和模板里的真实层级对上。
 */
const PASTE_INDENT = 6

/**
 * 解开 schemastery 的**引用表**序列化。
 *
 * `dsh-settings.describe()` 交出来的 `schema` **不是内联 JSON**，而是 schemastery
 * `toJSON()` 的引用表形态：
 *
 * ```json
 * { "uid": 30940,
 *   "refs": { "30797": { "type": "number", ... },
 *             "30940": { "type": "object", "dict": { "providers": 30798 } } } }
 * ```
 *
 * —— 节点之间用**数字 id** 互相引用：`dict` 的值可能是一个内联节点，也可能是一个 id。
 * 所以要判断"根级 providers 是不是 dict"，必须**先解引用**。
 *
 * ★ 2026-10-14 实测踩到的坑：本模块原先只认内联形态
 * `{type:'object', dict:{providers:{type:'dict'}}}`，于是**永远匹配不上** ——
 * 结果是插件在真机上一直走 `skipped: no-namespace`，**0.4.0 的核心功能
 * （把模型目录写成可编辑 provider）从未生效过一次**。而当时插件的日志用
 * `ctx.logger`、在 host 日志里完全不可见，于是"什么都没发生"被误读成了
 * "走了 `present` 空操作分支"。
 *
 * @param refs - 引用表（`schema.refs`）。
 * @param node - 待解引用的节点（可能是内联对象、数字 id 或数字字符串）。
 * @returns 解引用后的节点；解不到时 undefined。
 */
function deref(refs: Record<string, unknown>, node: unknown): Record<string, unknown> | undefined {
  let current: unknown = node
  // 上限只是防环，正常情况下 1~2 跳就到底。
  for (let hop = 0; hop < 32; hop += 1) {
    if (typeof current === 'number') {
      current = refs[String(current)]
      continue
    }
    if (typeof current === 'string' && /^\d+$/.test(current)) {
      current = refs[current]
      continue
    }
    break
  }
  return typeof current === 'object' && current !== null && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : undefined
}

/** 取一个节点的 `dict.<key>`（不解引用返回值）。 */
function dictField(node: Record<string, unknown> | undefined, key: string): unknown {
  const dict = node?.dict
  if (typeof dict !== 'object' || dict === null) return undefined
  return (dict as Record<string, unknown>)[key]
}

/** 从任意 `describe().schema` 里读出的形状信息（判定与诊断共用，避免两处漂移）。 */
interface ProvidersShape {
  /** 序列化形态：`inline`（内联）/ `refs`（引用表）/ `none`（不是对象）。 */
  form: 'none' | 'inline' | 'refs'
  /** 根节点的 `type`。 */
  rootType: string | undefined
  /** 根节点的键清单。 */
  rootKeys: string[]
  /** 根节点 `dict` 的键清单。 */
  dictKeys: string[]
  /** 根级 `providers` **解引用后**的 `type`。 */
  providersType: string | undefined
}

/**
 * 把 `describe().schema` 归一成 {@link ProvidersShape}。
 *
 * **两种形态都认**（见 {@link deref}）：
 *   · 内联：`{type:'object', dict:{providers:{type:'dict'}}}`
 *   · 引用表：`{uid, refs:{...}}` —— 这才是现在真机上的实际形状。
 *
 * @param schema - `descriptor.schema`。
 * @returns 形状信息；不是对象时 `form` 为 `none`。
 */
function readProvidersShape(schema: unknown): ProvidersShape {
  if (typeof schema !== 'object' || schema === null) {
    return { form: 'none', rootType: undefined, rootKeys: [], dictKeys: [], providersType: undefined }
  }
  const node = schema as Record<string, unknown>
  const refsRaw = node.refs
  const isRefTable = typeof refsRaw === 'object' && refsRaw !== null
    && (typeof node.uid === 'number' || (typeof node.uid === 'string' && /^\d+$/.test(node.uid)))
  const table = isRefTable ? (refsRaw as Record<string, unknown>) : {}
  const root = isRefTable ? deref(table, node.uid) : node
  const providersNode = deref(table, dictField(root, 'providers'))
  const dict = root?.dict
  return {
    form: isRefTable ? 'refs' : 'inline',
    rootType: asString(root?.type),
    rootKeys: root === undefined ? [] : Object.keys(root),
    dictKeys: typeof dict === 'object' && dict !== null ? Object.keys(dict) : [],
    providersType: asString(providersNode?.type),
  }
}

/**
 * 是否是根级 `providers` 为 dict 的 volatile 表单。
 *
 * 判定完全交给 {@link readProvidersShape}，所以内联与引用表两种形态**一视同仁**。
 *
 * @param schema - `descriptor.schema`。
 * @returns 是否可作为 provider 的落点。
 */
function isProvidersForm(schema: unknown): boolean {
  const shape = readProvidersShape(schema)
  return shape.form !== 'none' && shape.rootType === 'object' && shape.providersType === 'dict'
}

/** 一条 settings 条目的探测结果（诊断用）。 */
export interface NamespaceCandidateProbe {
  /** profile 条目 id。 */
  ns: string
  /** `descriptor.schema` 这个字段有没有值。 */
  hasSchema: boolean
  /** 序列化形态：`inline`（内联）/ `refs`（引用表）/ `none`。 */
  form: 'none' | 'inline' | 'refs'
  /** 根节点的 `type`。 */
  schemaType: string | undefined
  /** 根节点的键清单。 */
  schemaKeys: string[]
  /** 根节点 `dict` 的键清单；没有 dict 就是空数组。 */
  dictKeys: string[]
  /** 根级 `providers` **解引用后**的 `type`。 */
  providersType: string | undefined
  /** schema 的 JSON 摘要（截断），用于肉眼核对真实形状。 */
  schemaPreview: string
  /** 是否被判定为「providers 表单」。 */
  matched: boolean
}

/** 诊断里 schema JSON 摘要的截断长度。 */
const SCHEMA_PREVIEW_LIMIT = 220

/** 只在值确实是字符串时才返回它（诊断要的是"原样"，不是"猜"。） */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 把 `settings.describe()` 的**实际返回**摊开成诊断列表。
 *
 * ## 为什么需要它
 *
 * `no-namespace` 这条分支原先只说"没有「根级 providers 是 dict」的条目"，
 * 却**不说到底探测到了什么**。于是下面这些完全不同的故障，从输出上无法区分：
 *   · `describe()` 返回空 —— 条目还没激活，或 settings 是残的；
 *   · 有条目但确实没有 `schema` 字段；
 *   · 有 `schema` 但**形态不一样**（内联 vs 引用表 —— 见 {@link deref}）；
 *   · 有 `providers` 但类型不是 `dict`。
 *
 * ★ 2026-10-14：正是加上这个诊断之后，才看清 `describe()` 交出来的是
 *   `{uid, refs}` 引用表、而不是内联 JSON —— 于是找到了"插件从未生效"的真因。
 *   在此之前只能靠猜，且猜错了（误判成"走了 present 分支"）。
 *
 * @param settings - settings 服务。
 * @returns 每条目的探测结果；`describe` 缺失或抛错时返回空数组。
 */
export function probeNamespaceCandidates(
  settings: SettingsServiceLike | undefined,
): NamespaceCandidateProbe[] {
  if (settings?.describe === undefined) return []
  let descriptors: SettingsDescriptor[]
  try {
    descriptors = settings.describe({ redactSecrets: true }) ?? []
  } catch {
    return []
  }
  return descriptors.map((descriptor) => {
    const raw: unknown = descriptor.schema
    const shape = readProvidersShape(raw)
    let schemaPreview = '(schema 字段不存在)'
    if (raw !== undefined) {
      try {
        const text = JSON.stringify(raw) ?? String(raw)
        schemaPreview = text.length > SCHEMA_PREVIEW_LIMIT ? `${text.slice(0, SCHEMA_PREVIEW_LIMIT)}…` : text
      } catch {
        schemaPreview = '(无法 JSON 化)'
      }
    }
    return {
      ns: descriptor.ns,
      hasSchema: raw !== undefined,
      form: shape.form,
      schemaType: shape.rootType,
      schemaKeys: shape.rootKeys,
      dictKeys: shape.dictKeys,
      providersType: shape.providersType,
      schemaPreview,
      matched: isProvidersForm(raw),
    }
  })
}

/**
 * 把 {@link probeNamespaceCandidates} 的结果渲染成可读的多行诊断。
 *
 * 有 schema 的条目会额外打一行 JSON 摘要 —— 因为"形态不对"才是最难猜的那种故障；
 * 没有 schema 的条目只报一行，避免 20 多条把输出淹掉。
 *
 * @param probes - 探测结果。
 * @returns 诊断文本（首行是总数，随后逐条列出）。
 */
export function renderNamespaceProbe(probes: NamespaceCandidateProbe[]): string {
  if (probes.length === 0) {
    return 'settings.describe() 返回了 0 个条目 —— 此刻没有任何条目已激活。'
      + '注意 settings namespace 就是 profile 条目 id，只有已激活的条目才会出现在 describe() 里；'
      + '若刚刚启动，可能是 Loader 还没把条目挂上（本插件已按 namespaceAttempts 重试过）。'
  }
  const lines = probes.flatMap((probe) => {
    if (probe.matched) {
      return [`  ✅ ${probe.ns}：形态=${probe.form} · 根 type=object · providers.type=dict（可用）`]
    }
    if (!probe.hasSchema) return [`  · ${probe.ns}：describe() 里没有 schema 字段`]
    const shape = `  · ${probe.ns}：形态=${probe.form}`
      + ` · 根 type=${probe.schemaType ?? '(无)'}`
      + ` · 根键=[${probe.schemaKeys.join(', ')}]`
      + ` · dict 键=[${probe.dictKeys.join(', ')}]`
      + (probe.providersType === undefined ? '' : ` · providers.type=${probe.providersType}`)
    return [shape, `      ↳ ${probe.schemaPreview}`]
  })
  return `settings.describe() 返回了 ${probes.length} 个条目：\n${lines.join('\n')}`
}

/** 安全地取一个值里的 `providers` 字典。 */
function providersDict(value: unknown): Record<string, unknown> {
  const providers = (value as { providers?: unknown } | null | undefined)?.providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return {}
  return providers as Record<string, unknown>
}

/**
 * 数一份 provider 段里声明了几个模型（拿不到就 0）。
 *
 * 导出是给写路径安全网的读回探针用的：判定"这次写入有没有把模型写全"要看这个数。
 *
 * @param providerValue - `providers.<name>` 的值。
 * @returns 模型数量。
 */
export function countModels(providerValue: unknown): number {
  const models = (providerValue as { models?: unknown } | null | undefined)?.models
  return Array.isArray(models) ? models.length : 0
}

/**
 * 取一份 provider 段里所有模型的 id（拿不到就给空数组）。
 *
 * 用于 `--rebuild` 报告"你丢掉了哪些" —— 只说个数不够，操作员要看到具体是哪些 id。
 *
 * @param providerValue - `providers.<name>` 的值。
 * @returns 模型 id 列表（保持原有顺序）。
 */
export function modelIds(providerValue: unknown): string[] {
  const models = (providerValue as { models?: unknown } | null | undefined)?.models
  if (!Array.isArray(models)) return []
  return models
    .map(item => (item as { id?: unknown } | null | undefined)?.id)
    .filter((id): id is string => typeof id === 'string')
}

/**
 * 探测「根级 providers 是 dict」的 settings namespace。
 *
 * 不写死 `llm-pi-ai` 的理由：settings namespace **就是 profile 条目 id**，而条目
 * id 由组合决定 —— 本机是 `llm-pi-ai`，dev 构建里可能是 `include:llm-pi-ai`。
 *
 * 选择顺序：显式配置的 `preferred` → 字面量 `llm-pi-ai` → 字典序第一个。
 * 全程把候选列表带回去，选不出来时日志里能直接看到「到底探测到了什么」。
 *
 * @param settings - settings 服务（可能连 `describe` 都没有）。
 * @param preferred - 显式指定的 namespace，空串表示不指定。
 * @returns 目标 namespace；一个候选都没有时 undefined。
 */
export function findProviderNamespace(
  settings: SettingsServiceLike | undefined,
  preferred: string,
): ProviderNamespace | undefined {
  if (settings?.describe === undefined) return undefined
  let descriptors: SettingsDescriptor[]
  try {
    descriptors = settings.describe({ redactSecrets: true }) ?? []
  } catch {
    return undefined
  }
  const matched = descriptors.filter(descriptor => isProvidersForm(descriptor.schema))
  if (matched.length === 0) return undefined
  const candidates = matched.map(descriptor => descriptor.ns).sort()
  const chosen = (preferred.length > 0 ? matched.find(descriptor => descriptor.ns === preferred) : undefined)
    ?? matched.find(descriptor => descriptor.ns === 'llm-pi-ai')
    ?? matched.slice().sort((left, right) => left.ns.localeCompare(right.ns))[0]
  return {
    ns: chosen.ns,
    revision: chosen.revision,
    providers: {
      ...providersDict(chosen.base),
      ...providersDict(chosen.user),
      ...providersDict(chosen.value),
    },
    candidates,
  }
}

/**
 * provider 是否已经存在（**任意一层**出现过就算存在）。
 *
 * 三层都看是刻意的：操作员可能把 provider 写在 profile 覆盖层（`user`，也就是
 * `cordis.patch.yml`），也可能写在继承层（`base`，bundle 自带）。只要任何一层
 * 提到了这个名字，本插件就**什么都不做** —— 存在性判定宁可偏保守。
 *
 * @param namespace - {@link findProviderNamespace} 的结果。
 * @param name - `providers.<name>` 的键名。
 * @returns 是否已存在。
 */
export function providerExists(namespace: ProviderNamespace, name: string): boolean {
  return Object.hasOwn(namespace.providers, name) && namespace.providers[name] !== undefined
}

/** 取正整数字段；非正数、非数、非整数一律视为「网关没说」。 */
function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * 把原始目录翻译成 provider 配置段。
 *
 * 逐字段规则：
 * - `id` —— 原样保留（含 realm 前缀）。
 * - `name` —— 只在网关给了非空字符串时写。
 * - `contextWindow` ← `context_length`；**缺失就不写**（pi-ai 会退到 262144）。
 * - `maxTokens` ← `max_output_tokens`；**缺失就不写**（pi-ai 会退到路由的
 *   `defaultMaxTokens`，进而是 32768）。
 * - `input` —— `supports_images` 为真给 `['text','image']`，否则 `['text']`
 *   （与 `models.ts` 的 `mapModel` 同一口径：缺席是**显式否定**，不是未知）。
 * - `reasoningEfforts` —— 网关档位做成恒等映射；不在 {@link THINKING_LEVELS} 内的
 *   档位丢弃并记进 notes。
 *
 * 重复 id 折叠成一条（pi-ai 会以「lists model ... more than once」直接拒绝整份配置）。
 *
 * @param entries - {@link GatewayCatalogEntry} 列表。
 * @param options - 凭据 ref 名与端点。
 * @returns 配置段与「哪些字段被略过」的说明。
 */
export function buildProviderProfile(
  entries: readonly GatewayCatalogEntry[],
  options: BuildProviderProfileOptions,
): ProviderProfileBuild {
  const models: ProviderModelProfile[] = []
  const notes: ProviderModelNote[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      const previous = notes.find(note => note.id === entry.id)
      if (previous !== undefined) previous.duplicateOf = `（网关名单里重复出现，已折叠）`
      else notes.push({ id: entry.id, absent: [], droppedEfforts: [], duplicateOf: '（网关名单里重复出现，已折叠）' })
      continue
    }
    seen.add(entry.id)
    const contextWindow = positiveInteger(entry.contextLength)
    const maxTokens = positiveInteger(entry.maxOutputTokens)
    const efforts = entry.reasoningEfforts.filter(level => THINKING_LEVELS.includes(level))
    const droppedEfforts = entry.reasoningEfforts.filter(level => !THINKING_LEVELS.includes(level))
    const absent: string[] = []
    if (contextWindow === undefined) absent.push('contextWindow')
    if (maxTokens === undefined) absent.push('maxTokens')
    if (absent.length > 0 || droppedEfforts.length > 0) {
      notes.push({ id: entry.id, absent, droppedEfforts })
    }
    models.push({
      id: entry.id,
      ...entry.name !== undefined ? { name: entry.name } : {},
      ...contextWindow !== undefined ? { contextWindow } : {},
      ...maxTokens !== undefined ? { maxTokens } : {},
      input: entry.supportsImages === true ? ['text', 'image'] : ['text'],
      ...efforts.length > 0
        ? { reasoningEfforts: Object.fromEntries(efforts.map(level => [level, level])) }
        : {},
    })
  }
  return {
    profile: {
      apiKeyEnv: options.apiKeyEnv,
      api: GATEWAY_WIRE_API,
      baseURL: options.baseURL,
      retryPolicy: { ...GATEWAY_RETRY_POLICY },
      models,
    },
    notes,
  }
}

/** 判断一个字符串能否不加引号地当 YAML 纯量（保守：拿不准就加引号）。 */
function isPlainYamlScalar(value: string): boolean {
  if (value.length === 0) return false
  if (!/^[A-Za-z0-9_][A-Za-z0-9_\-. ]*$/.test(value)) return false
  // YAML 1.1 的布尔/空值字面量，加引号才不会变成 true/false/null。
  return !/^(true|false|yes|no|on|off|null|~)$/i.test(value)
}

/** 渲染一个 YAML 标量（必要时加双引号并转义）。 */
function yamlScalar(value: string): string {
  if (isPlainYamlScalar(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 把 provider 段渲染成**可直接粘贴**的 YAML 片段。
 *
 * 手写渲染而不是引 YAML 库：仓库的立场是不为一件小事加运行时依赖
 * （`zip.ts` 同理），而这里要输出的结构完全由本模块决定，键序与缩进都能钉死。
 *
 * 缩进是参数而不是常量：块本身只描述 `providers:` **下面**那一层，要贴进
 * `cordis.patch.yml` 就得对齐 `llm-pi-ai.config` 的层级（见 {@link PASTE_INDENT}）。
 *
 * **对残缺的条目要宽容**：只增不删的写回会把「操作员现有的条目**原样**」带进来，
 * 那些条目未必是本模块生成的（可能只有一行 `- id: x`）。渲染器遇到这种输入只补
 * 缺省（`input` 缺席即仅文本，与 `models.ts` 同一口径），**绝不能抛** ——
 * 它是在失败路径上给操作员抄的退路，退路自己崩掉就等于没有退路。
 *
 * @param name - `providers.<name>` 的键名。
 * @param profile - {@link buildProviderProfile} 生成的结果。
 * @param indent - 每行前面补的空格数（默认 0）。
 * @returns YAML 片段（带尾换行）。
 */
export function renderProviderProfileYaml(name: string, profile: ProviderProfile, indent = 0): string {
  const pad = ' '.repeat(indent)
  const lines: string[] = []
  lines.push(`${yamlScalar(name)}:`)
  lines.push(`  apiKeyEnv: ${yamlScalar(profile.apiKeyEnv)}`)
  lines.push(`  api: ${yamlScalar(profile.api)}`)
  lines.push(`  baseURL: ${yamlScalar(profile.baseURL)}`)
  lines.push('  retryPolicy:')
  lines.push(`    mode: ${yamlScalar(profile.retryPolicy.mode)}`)
  lines.push(`    maxRetries: ${profile.retryPolicy.maxRetries}`)
  lines.push('  models:')
  for (const model of profile.models) {
    lines.push(`    - id: ${yamlScalar(model.id)}`)
    if (model.name !== undefined) lines.push(`      name: ${yamlScalar(model.name)}`)
    if (model.contextWindow !== undefined) lines.push(`      contextWindow: ${model.contextWindow}`)
    if (model.maxTokens !== undefined) lines.push(`      maxTokens: ${model.maxTokens}`)
    // 缺席 = 仅文本（与 models.ts 的 supports_images 口径一致），只是为了别让
    // 一份残缺的既有条目把这段退路渲染搞崩。
    const modalities = Array.isArray(model.input) ? model.input : ['text']
    lines.push('      input:')
    for (const modality of modalities) lines.push(`        - ${yamlScalar(modality)}`)
    if (model.reasoningEfforts !== undefined) {
      lines.push('      reasoningEfforts:')
      for (const [level, wire] of Object.entries(model.reasoningEfforts)) {
        lines.push(`        ${yamlScalar(level)}: ${yamlScalar(wire)}`)
      }
    }
  }
  return `${lines.map(line => `${pad}${line}`).join('\n')}\n`
}

/**
 * 计算「网关现在服务的」与「配置里写着的」之间的差异。**只读，不写任何东西。**
 *
 * 存在的理由：生成只做一次，网关后来上新的模型不会再自动出现。操作员需要一条
 * 不产生副作用的途径看到差异，再由他自己决定要不要在模型页加。
 *
 * @param profile - 配置里现有的模型清单。
 * @param entries - 网关当前目录。
 * @returns 缺失、下架与数值漂移三组差异。
 */
export function diffProviderModels(
  profile: ProviderProfile,
  entries: readonly GatewayCatalogEntry[],
): ProviderModelDiff {
  const configured = new Map(profile.models.map(model => [model.id, model]))
  const live = new Map(entries.map(entry => [entry.id, entry]))
  const missingFromProfile: string[] = []
  const unknownToGateway: string[] = []
  const drifted: ProviderModelDiff['drifted'] = []
  for (const id of live.keys()) if (!configured.has(id)) missingFromProfile.push(id)
  for (const id of configured.keys()) if (!live.has(id)) unknownToGateway.push(id)
  for (const [id, model] of configured) {
    const entry = live.get(id)
    if (entry === undefined) continue
    const pairs: Array<['contextWindow' | 'maxTokens', number | undefined, number | undefined]> = [
      ['contextWindow', model.contextWindow, entry.contextLength],
      ['maxTokens', model.maxTokens, entry.maxOutputTokens],
    ]
    for (const [field, mine, theirs] of pairs) {
      if (mine === undefined || theirs === undefined || mine === theirs) continue
      drifted.push({ id, field, configured: mine, gateway: theirs })
    }
  }
  return { missingFromProfile, unknownToGateway, drifted }
}

/** 把 notes 渲染成可读的几行（空数组给空数组，调用方直接铺开）。 */
export function renderProviderNotes(notes: readonly ProviderModelNote[]): string[] {
  return notes.map((note) => {
    const parts: string[] = []
    if (note.absent.length > 0) {
      parts.push(`网关未下发 ${note.absent.join(' / ')}`
        + `${note.absent.includes('contextWindow') ? '（⚠ 留空会被 pi-ai 当成 262144，请在模型页核对）' : ''}`)
    }
    if (note.droppedEfforts.length > 0) parts.push(`丢弃了 pi-ai 不认的档位 ${note.droppedEfforts.join(' / ')}`)
    if (note.duplicateOf !== undefined) parts.push(note.duplicateOf)
    return `  · ${note.id}: ${parts.join('；')}`
  })
}

/**
 * 取一份 provider 段里的 `models` **数组本身**（拿不到就给空数组）。
 *
 * 与 {@link modelIds} 的区别：这里不抽取 id，而是把条目**原对象**留着 ——
 * 只增不删的写回要的是「用户现有条目**原样**」，不是重新生成一份。
 *
 * @param providerValue - `providers.<name>` 的值。
 * @returns 原数组的浅拷贝；不是数组时 `[]`。
 */
function modelEntries(providerValue: unknown): unknown[] {
  const models = (providerValue as { models?: unknown } | null | undefined)?.models
  return Array.isArray(models) ? [...models] : []
}

/** 并集（去重，保持首次出现的顺序）。墓碑集合的每一处合并都走它。 */
function unionIds(...groups: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const group of groups) {
    for (const id of group) {
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/**
 * 读墓碑：**读不到就是「没有记录」**。
 *
 * 没接线、抛错、返回 `undefined` 三种情形在这里被收敛成同一个语义（没有记录），
 * 于是 `--rebuild` 会走保守路径 —— 少加几个模型是可以接受的，复活已删模型不行。
 */
async function readOfferedSafe(deps: SeedDeps): Promise<string[] | undefined> {
  if (deps.readOffered === undefined) return undefined
  try {
    return await deps.readOffered()
  } catch {
    return undefined
  }
}

/**
 * 写墓碑。**失败只回一句话，绝不抛给调用方**。
 *
 * 这条边界是刻意的：墓碑是我们自己的账本，写不进去只该「下次重新记」，
 * 不该把一次**已经成功**的 provider 写入报告成失败。
 *
 * @returns 失败说明；成功或没接线时 undefined。
 */
async function commitOffered(deps: SeedDeps, ids: string[]): Promise<string | undefined> {
  if (deps.writeOffered === undefined) return undefined
  try {
    await deps.writeOffered(ids)
    return undefined
  } catch (error) {
    return `墓碑集合没能写回（**不影响本次 provider 写入**）：${error instanceof Error ? error.message : String(error)}`
      + ' —— 下一次刷新会重新记录。'
  }
}

/** 没有上一次记录时 `rebuilt` 的固定说明（渲染层直接印）。 */
const NO_BASELINE_HOLD = '没有上一次的「提供过哪些」记录，无法区分「网关新增」与「你删掉的」'
  + ' —— 本次**一个都不加**（加错就是复活你删掉的模型）。'
  + '本次已把网关当前目录记为基线，之后的刷新只会补真正新增的。'

/**
 * 保证「设置 → 模型」里那份可编辑 provider 存在。**默认存在即返回，绝不改写。**
 *
 * 顺序：
 *  1. 等 Loader 把 profile 条目激活后探测 namespace（可重试）；
 *  2. provider 已存在且没要求刷新 → 直接返回 `present`，**连 `/v1/models` 都不拉**，
 *     只把「迄今提供过的并集」续进墓碑（本来没有记录时不从零造，见下）；
 *  3. 缺失 → 拉网关目录（可重试），整份创建（`created`）；
 *  4. `deps.overwrite === true`（`/wb2api-provider --rebuild`）且已存在 → 拉网关目录，
 *     但走**只增不删**：`added = 目录 − 配置里已有的 − 墓碑里的`，写回
 *     「现有条目原样 + added」；`added` 为空时**一个字节都不写**；
 *  5. **写前**：`guard.snapshot()` 把整份 patch 备份到 profile 之外；**备份不了就不写**；
 *  6. `mutate` 写入 `['providers', <name>]`；
 *  7. **写后**：`guard.verify()` 独立读回核对条目数；判定不可信 → `guard.rollback()`
 *     把备份盖回去，返回 `rolled-back`；
 *  8. 任何一步失败 → 返回 `failed` 并附上可粘贴的 YAML（拿得到目录时）。
 *
 * **墓碑（`readOffered` / `writeOffered`）是「只增不删」的唯一记忆载体**：一个 id
 * 只要曾经被提供过，就永远进不了 `added`。没有记录时（或没接线时）`--rebuild`
 * 保守地什么都不加，并把原因写进 `holdReason` —— 宁可少加，不可复活。
 *
 * 两处**刻意保守**的地方（都会在真机上出现，不是理论情形）：
 *   · `present` **不从零造记录** —— 当前配置只说明"用户留着这些"，不说明"我们提供过
 *     这些"；拿它当基线，下一次 `--rebuild` 就会把用户在这个版本之前删掉的模型
 *     全部加回来。
 *   · 因此「没有记录」会一直保留到下一次 `--rebuild`，由它按 `holdReason` 那条规则
 *     处理：一个都不加，同时把网关当前目录立成基线，记忆从那一刻开始生效。
 *
 * 函数本身**不写日志**：返回结构化结果，由调用方渲染。这样它在单测里不需要
 * cordis，也不需要真网关。
 *
 * @param deps - settings 服务、provider 名、目录来源、墓碑与写路径安全网。
 * @returns 本次的动作与说明。
 */
export async function seedEditableProvider(deps: SeedDeps): Promise<SeedOutcome> {
  const settings = deps.settings
  if (settings === undefined || typeof settings.describe !== 'function' || typeof settings.mutate !== 'function') {
    return {
      kind: 'skipped',
      reason: 'no-settings-service',
      detail: 'settings 服务缺失或没有 mutate/describe（本机会因此无法自动创建 provider）',
    }
  }
  const sleep = deps.sleep ?? (async (ms: number) => { await new Promise(resolve => { setTimeout(resolve, ms) }) })
  const namespaceAttempts = deps.namespaceAttempts ?? DEFAULT_NAMESPACE_ATTEMPTS
  const namespaceIntervalMs = deps.namespaceIntervalMs ?? DEFAULT_NAMESPACE_INTERVAL_MS
  const catalogAttempts = deps.catalogAttempts ?? DEFAULT_CATALOG_ATTEMPTS
  const catalogIntervalMs = deps.catalogIntervalMs ?? DEFAULT_CATALOG_INTERVAL_MS

  let namespace = findProviderNamespace(settings, deps.preferredNamespace)
  for (let attempt = 1; namespace === undefined && attempt < namespaceAttempts; attempt += 1) {
    await sleep(namespaceIntervalMs)
    namespace = findProviderNamespace(settings, deps.preferredNamespace)
  }
  if (namespace === undefined) {
    return {
      kind: 'skipped',
      reason: 'no-namespace',
      detail: 'settings.describe() 里没有任何「根级 providers 是 dict」的条目'
        + `${deps.preferredNamespace.length > 0 ? `（已指定 providerNamespace=${deps.preferredNamespace}）` : ''}`
        // 把**实际探测到什么**一并报出来。只报"没找到"会让几种完全不同的故障
        // 长得一模一样 —— 2026-10-14 就是被这一点卡住的（见 probeNamespaceCandidates）。
        + `\n${renderNamespaceProbe(probeNamespaceCandidates(settings))}`,
    }
  }
  const existing = namespace.providers[deps.providerName]
  const alreadyExists = providerExists(namespace, deps.providerName)
  // ★ 核心不变量：provider 已存在就返回，连 `/v1/models` 都不拉。
  //   只有操作员显式要求刷新（`/wb2api-provider --rebuild`）才越过它。
  if (alreadyExists && deps.overwrite !== true) {
    // present 在有记录时**续**墓碑（只增不减：用户删过的 id 绝不能被这一轮抹掉，
    // 否则下一次 --rebuild 就会把它加回来）。
    //
    // ★ 没有记录时**不**拿当前配置去造一条基线：配置里的 id 只说明「用户留着它们」，
    //   不说明「我们提供过它们」。拿它当基线，下一次 --rebuild 就会把用户（在这个
    //   版本之前）删掉的模型全部加回来 —— 那正是这套机制要防的事。
    //   于是「没有记录」这个状态被**保留**到下一次 --rebuild，由它按保守规则处理
    //   （一个都不加 + 把网关目录立成基线）。
    const currentIds = modelIds(existing)
    const offeredBefore = await readOfferedSafe(deps)
    const offeredModels = offeredBefore === undefined ? currentIds : unionIds(offeredBefore, currentIds)
    const stateWarning = offeredBefore === undefined ? undefined : await commitOffered(deps, offeredModels)
    return {
      kind: 'present',
      ns: namespace.ns,
      modelCount: countModels(existing),
      offeredModels,
      offeredRecorded: offeredBefore !== undefined,
      ...(stateWarning === undefined ? {} : { stateWarning }),
    }
  }
  let entries: GatewayCatalogEntry[] | undefined
  let lastError = ''
  for (let attempt = 1; attempt <= catalogAttempts; attempt += 1) {
    try {
      entries = await deps.fetchEntries()
      break
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt < catalogAttempts) await sleep(catalogIntervalMs)
    }
  }
  if (entries === undefined) {
    return {
      kind: 'failed',
      reason: 'gateway-unreachable',
      detail: `provider "${deps.providerName}" 不存在，且连续 ${catalogAttempts} 次拉取 ${deps.baseURL}/models 都失败：${lastError}`,
      notes: [],
    }
  }

  const build = buildProviderProfile(entries, { apiKeyEnv: deps.apiKeyEnv, baseURL: deps.baseURL })

  // ── 分支 1：只增不删（`--rebuild` 且 provider 已存在） ─────────────────────
  // 判据是「**从没提供过**」，不是「目录里有、条目里没有」：
  //   added = 目录 − 配置里已有的（kept，用户留着的） − 墓碑（offered，我们提供过的）
  // 少了 offered 这一半，用户删掉的模型下一次刷新就会回来 —— 那正是这一整套机制
  // 存在的理由。
  if (alreadyExists) {
    const keptIds = modelIds(existing)
    const keptSet = new Set(keptIds)
    const offeredBefore = await readOfferedSafe(deps)
    // undefined = 没有记录（≠ 记录是空数组）。没有记录时**保守地什么都不加**。
    const hasBaseline = offeredBefore !== undefined
    const offeredSet = new Set(offeredBefore ?? [])
    const catalogIds = build.profile.models.map(model => model.id)
    const addedModels = hasBaseline
      ? build.profile.models.filter(model => !keptSet.has(model.id) && !offeredSet.has(model.id))
      : []
    const addedIds = addedModels.map(model => model.id)
    const keptModels = countModels(existing)
    // 用户现有的条目**原样**带过去（不改数值、不重排、不丢弃）：只增不删的全部含义
    // 就在这一行。网关那边如今也有这些 id 时，去覆盖操作员在模型页调过的数值
    // 不是本命令的职责。
    const existingModels = modelEntries(existing) as ProviderModelProfile[]
    const mergedModels: ProviderModelProfile[] = [...existingModels, ...addedModels]
    // 手工块按**合并后**的清单渲染：万一写入失败，操作员把它贴回去得到的就是
    // 「只增不删」的那份结果，而不是"按网关整份覆盖"的老行为。
    const manualBlock = renderProviderProfileYaml(
      deps.providerName,
      { ...build.profile, models: mergedModels },
      PASTE_INDENT,
    )
    // 新增模型的字段说明只保留新增的那些：没写进去的模型不需要人核对。
    const notes = build.notes.filter(note => addedIds.includes(note.id))

    // 没有新增 ⇒ **不写 patch**（无意义的写入只会把 patch 的 mtime 搅乱，
    // 还会白跑一次备份/核对）。但墓碑仍要立起来，否则机制永远不会开始工作。
    if (addedIds.length === 0) {
      const offeredModels = hasBaseline
        ? unionIds(offeredBefore ?? [], keptIds)
        : unionIds(keptIds, catalogIds)
      // 「rebuilt 且真写了」才写回墓碑 —— 唯一的例外是**本来就没有记录**：
      // 那时必须先把基线记下来，否则每一次刷新都会永远停在「一个都不加」。
      const stateWarning = hasBaseline ? undefined : await commitOffered(deps, offeredModels)
      return {
        kind: 'rebuilt',
        ns: namespace.ns,
        addedModels: [],
        keptModels,
        offeredModels,
        notes: [],
        ...(hasBaseline ? {} : { holdReason: NO_BASELINE_HOLD }),
        ...(stateWarning === undefined ? {} : { stateWarning }),
      }
    }

    // ── 铁律 ①：写前备份，且备份必须落在 profile 之外 ────────────────────────
    // 这里有两个"不写"的分支：没接线安全网、以及备份失败。
    if (deps.guard === undefined) {
      return {
        kind: 'failed',
        reason: 'write-failed',
        detail: '没有接线写路径安全网（WriteGuard），已放弃写入 —— 见 PROJECT.md §0「写配置铁律」。'
          + '插件不在没有退路的情况下改用户配置。',
        manualBlock,
        notes,
      }
    }
    let baseline: WriteBaseline
    try {
      baseline = await deps.guard.snapshot()
    } catch (error) {
      return {
        kind: 'failed',
        reason: 'write-failed',
        detail: `写入前备份失败，已放弃写入：${error instanceof Error ? error.message : String(error)}`,
        manualBlock,
        notes,
      }
    }

    try {
      await settings.mutate(
        namespace.ns,
        [{ op: 'set', path: ['providers', deps.providerName], value: { ...build.profile, models: mergedModels } }],
        namespace.revision,
      )
    } catch (error) {
      return {
        kind: 'failed',
        reason: 'write-failed',
        detail: error instanceof Error ? error.message : String(error),
        manualBlock,
        notes,
      }
    }

    // ── 铁律 ②③：写后读回核对条目数；条目少了立即回滚 ────────────────────────
    const verdict = await deps.guard.verify(baseline, { modelCount: mergedModels.length })
    if (verdict.ok) {
      const offeredModels = unionIds(offeredBefore ?? [], keptIds, addedIds)
      const stateWarning = await commitOffered(deps, offeredModels)
      return {
        kind: 'rebuilt',
        ns: namespace.ns,
        addedModels: addedIds,
        keptModels,
        offeredModels,
        backupPath: baseline.backupPath,
        notes,
        ...(stateWarning === undefined ? {} : { stateWarning }),
      }
    }
    // 恢复优先于报告：先把文件盖回去，再组织措辞。
    let recovery: string
    try {
      await deps.guard.rollback(baseline)
      recovery = `已从备份整份盖回（${baseline.backupPath}），配置与写入前一致。`
        + 'DSH 会热加载 profile patch；若没生效，重启一次即可。'
    } catch (error) {
      recovery = `⚠ 回滚失败：${error instanceof Error ? error.message : String(error)}`
        + `\n请手工把 ${baseline.backupPath} 覆盖回 profile 的 cordis.patch.yml。`
    }
    // ★ 回滚分支**不写墓碑**：这次写入没被采信，墓碑就不能替它背书。
    return {
      kind: 'rolled-back',
      ns: namespace.ns,
      reasons: verdict.reasons,
      backupPath: baseline.backupPath,
      recovery,
      manualBlock,
      notes,
    }
  }

  // ── 分支 2：创建（provider 本来就不存在） ──────────────────────────────────
  const manualBlock = renderProviderProfileYaml(deps.providerName, build.profile, PASTE_INDENT)

  // ── 铁律 ①：写前备份，且备份必须落在 profile 之外 ──────────────────────────
  // 这里有两个"不写"的分支：没接线安全网、以及备份失败。
  // 方向是刻意的 —— "备份不了就先写"换来的是"可能再发生一次 34 → 3 而没有任何
  // 退路"，而它的全部收益只是"也许这次能成功"。收益与代价不成比例。
  if (deps.guard === undefined) {
    return {
      kind: 'failed',
      reason: 'write-failed',
      detail: '没有接线写路径安全网（WriteGuard），已放弃写入 —— 见 PROJECT.md §0「写配置铁律」。'
        + '插件不在没有退路的情况下改用户配置。',
      manualBlock,
      notes: build.notes,
    }
  }
  let baseline: WriteBaseline
  try {
    baseline = await deps.guard.snapshot()
  } catch (error) {
    return {
      kind: 'failed',
      reason: 'write-failed',
      detail: `写入前备份失败，已放弃写入：${error instanceof Error ? error.message : String(error)}`,
      manualBlock,
      notes: build.notes,
    }
  }

  try {
    await settings.mutate(
      namespace.ns,
      [{ op: 'set', path: ['providers', deps.providerName], value: build.profile }],
      namespace.revision,
    )
  } catch (error) {
    return {
      kind: 'failed',
      reason: 'write-failed',
      detail: error instanceof Error ? error.message : String(error),
      manualBlock,
      notes: build.notes,
    }
  }

  // ── 铁律 ②③：写后读回核对条目数；条目少了立即回滚 ─────────────────────────
  // `mutate` 没抛错**不等于**内容还在 —— 2026-10-08 那次它就没抛错，而文件已经
  // 从 34 条目变成 3 条目。所以"写入成功"必须再被独立确认一次。
  const verdict = await deps.guard.verify(baseline, { modelCount: build.profile.models.length })
  if (verdict.ok) {
    const writtenIds = build.profile.models.map(model => model.id)
    // created 是"第一次全都算提供过"：此刻写进去的每一个 id 都进了墓碑。
    const offeredModels = unionIds((await readOfferedSafe(deps)) ?? [], writtenIds)
    const stateWarning = await commitOffered(deps, offeredModels)
    return {
      kind: 'created',
      ns: namespace.ns,
      modelCount: build.profile.models.length,
      notes: build.notes,
      offeredModels,
      ...(stateWarning === undefined ? {} : { stateWarning }),
    }
  }
  // 恢复优先于报告：先把文件盖回去，再组织措辞。
  let recovery: string
  try {
    await deps.guard.rollback(baseline)
    recovery = `已从备份整份盖回（${baseline.backupPath}），配置与写入前一致。`
      + 'DSH 会热加载 profile patch；若没生效，重启一次即可。'
  } catch (error) {
    recovery = `⚠ 回滚失败：${error instanceof Error ? error.message : String(error)}`
      + `\n请手工把 ${baseline.backupPath} 覆盖回 profile 的 cordis.patch.yml。`
  }
  // ★ 回滚分支**不写墓碑**：这次写入没被采信，墓碑就不能替它背书。
  return {
    kind: 'rolled-back',
    ns: namespace.ns,
    reasons: verdict.reasons,
    backupPath: baseline.backupPath,
    recovery,
    manualBlock,
    notes: build.notes,
  }
}
