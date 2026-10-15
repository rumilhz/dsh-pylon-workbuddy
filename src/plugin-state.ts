/**
 * 插件**自己**的状态文件：墓碑集合（tombstone）。
 *
 * ## 它解决什么
 *
 * `--rebuild` 过去是「按网关目录整份重建」，于是把操作员在模型页删掉的模型
 * **原样复活**。根因是配置里根本没有「这个 id 是被故意删掉的」这种信息 ——
 * 光看「网关有 45 个、你配了 10 个」永远分不清另外 35 个里哪些是新增、哪些是你删的。
 *
 * 出路是把「**我们提供过哪些 id**」记下来。记下来之后：
 *
 * ```
 * added = 网关目录 − 配置里已有的（用户留着的） − 上次提供过的（墓碑）
 * ```
 *
 * 一个 id 只要**曾经被提供过**，就永远进不了 `added` —— 用户删掉它这件事因此
 * 是永久有效的，除非用户自己在模型页把它加回来。
 *
 * ## 落盘位置：`<DSH_HOME>/.wb2api/state.json`（**有点**）
 *
 * ★ 网关自己的工作目录是 `~/.dsh/wb2api/`（**没点**）：
 *       ~/.dsh/wb2api/          ← 网关的（wb2a-server.exe / config.json / auths/ / data/）
 *       ~/.dsh/.wb2api/         ← 本插件的（state.json）
 *   两个不同目录，**绝不能撞** —— 撞上去就是把插件状态写进网关的运行时目录。
 *
 * ## 拿不到 home 时降级，不抛错
 *
 * home 的来源依次是：`profileContext.home` → 环境变量 `DSH_HOME` → `~/.dsh`
 * （最后一条就是 DSH 自己的默认值）。前两条都拿不到、连 `os.homedir()` 也拿不到时
 * （容器里没挂 home、被裁剪过的运行时），{@link resolveStateLocation} 返回
 * `undefined`，调用方据此**不启用墓碑**：`--rebuild` 退化成「什么都不加」的保守行为，
 * 而不是抛错把插件启动搞挂。宁可少一个能力，不可多一次启动失败。
 *
 * ## 读写都是「尽力而为」
 *
 * · 读：文件不存在 / JSON 坏 / 结构不对 ⇒ 一律当「**没有记录**」（`undefined`）。
 *   刻意与「记录是空数组」区分开：前者叫「不知道」，后者叫「知道，一个都没提供过」，
 *   两者在 `--rebuild` 里的处置完全不同（见 `provider-config.ts`）。
 * · 写：读-改-写 + 浅合并（只动 `providers.<name>.lastOffered`，不碰别的键），
 *   落盘用 `writeFileSync(path, text, 'utf8')`。写失败**抛给调用方**，由它决定
 *   怎么在结果里注明 —— 但绝不因此影响 provider 配置本身的写入。
 *
 * @module dsh-pylon-workbuddy/plugin-state
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 状态文件的 schema 版本。结构变了就 +1，读的时候按版本决定怎么解释。 */
export const STATE_SCHEMA_VERSION = 1

/**
 * 状态目录名。**有点** —— 与网关的运行目录 `wb2api`（没点）是两个目录。
 *
 * 改成 `wb2api` 会把插件状态写进网关的运行时目录（那里放着 `wb2a-server.exe`、
 * `config.json`、`auths/` 与 `data/state.json`），所以这个名字不是随手起的。
 */
export const STATE_DIR_NAME = '.wb2api'

/** 状态文件名。 */
export const STATE_FILE_NAME = 'state.json'

/** 一个 provider 的墓碑记录。 */
export interface ProviderTombstone {
  /** **迄今提供过**的全部模型 id（并集，去重，保持首次出现的顺序）。 */
  lastOffered: string[]
}

/** 状态文件的形状（可扩展：新字段加在这里，老文件缺字段按缺省处理）。 */
export interface PluginState {
  /** schema 版本。 */
  version: number
  /** provider 名 → 墓碑。 */
  providers: Record<string, ProviderTombstone>
}

/** home 是哪来的（诊断用；也用来解释「为什么墓碑没生效」）。 */
export type HomeSource = 'profile' | 'env' | 'default'

/** 推导出来的状态落点。 */
export interface StateLocation {
  /** DSH 数据根（`~/.dsh`）。 */
  home: string
  /** 状态文件绝对路径。 */
  path: string
  /** home 的出处。 */
  source: HomeSource
}

/** {@link resolveStateLocation} 的入参（全部可注入，便于单测）。 */
export interface StateLocationInput {
  /** `profileContext.home`（运行中的实例最权威的来源）。 */
  profileHome?: string | undefined
  /** 环境变量表；缺省用 `process.env`。 */
  env?: Record<string, string | undefined> | undefined
  /** 注入 `os.homedir`；返回空串/`undefined` 表示「拿不到」。 */
  homedir?: (() => string | undefined) | undefined
}

/** 非空字符串才算「拿到了」。 */
function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** {@link resolveDshHome} 的入参（可注入，便于单测）。 */
export interface DshHomeInput {
  /** 环境变量表；缺省用 `process.env`。 */
  env?: Record<string, string | undefined> | undefined
  /** 注入 `os.homedir`；返回空串/`undefined`、或直接抛错，都算「拿不到」。 */
  homedir?: (() => string | undefined) | undefined
}

/**
 * DSH 数据根：`DSH_HOME`（非空）→ `~/.dsh`。**全插件唯一的 home 口径。**
 *
 * ## 为什么它必须是唯一的一份
 *
 * `state.json` / `boot.log` 的落点、网关安装目录、网关运行目录、网关 `auths/` 目录
 * 全都以 DSH home 为基准。只把其中几处改成认 `DSH_HOME`，就会得到一种最难查的形态：
 * 轨迹写在隔离 home 里（看起来"隔离成功"），而网关二进制与凭证却落进活体
 * `~/.dsh/wb2api`（2026-10-15「真·从零验证」实测到的正是这一条）。
 *
 * `DSH_HOME` 未设时逐字等于 DSH 自己的默认值（`~/.dsh`），活体用户行为完全不变；
 * 设了 `DSH_HOME` 的隔离验证/多实例环境，则整体跟着走。
 *
 * @param input - 可注入的 env / homedir（单测用）。
 * @returns 绝对路径；两条来源都拿不到时 `undefined`（调用方据此降级，而不是抛错）。
 */
export function resolveDshHome(input: DshHomeInput = {}): string | undefined {
  const env = input.env ?? process.env
  const fromEnv = nonEmpty(env['DSH_HOME'])
  if (fromEnv !== undefined) return fromEnv
  const homedir = input.homedir ?? osHomedir
  let base: string | undefined
  try {
    base = nonEmpty(homedir())
  } catch {
    base = undefined
  }
  return base === undefined ? undefined : join(base, '.dsh')
}

/**
 * {@link resolveDshHome} 的**字符串版** —— 给「无论如何都要拼出一条路径」的调用点
 * （网关安装目录 / 网关运行目录 / 网关 `auths/` 目录；它们没有「不落盘」这条分支）。
 *
 * `DSH_HOME` 未设时逐字等于旧行为：`join(os.homedir(), '.dsh')`。连 `os.homedir()`
 * 都拿不到的极端环境仍然走老路（照旧抛错，或拼出一条相对路径），**不会**静默换成
 * 别的目录 —— 那会把「读不到 home」伪装成一个更难查的写入错误。
 */
export function dshHome(): string {
  return resolveDshHome() ?? join(osHomedir(), '.dsh')
}

/**
 * 状态文件的绝对路径。
 *
 * @param home - DSH 数据根。
 * @returns `<home>/.wb2api/state.json`。
 */
export function stateFilePath(home: string): string {
  return join(home, STATE_DIR_NAME, STATE_FILE_NAME)
}

/**
 * 推导状态文件的落点。
 *
 * 顺序：`profileHome` → {@link resolveDshHome}（`DSH_HOME` → `~/.dsh`，DSH 自己的默认值）。
 * 三条都拿不到时返回 `undefined` —— **调用方据此不启用墓碑，而不是抛错**。
 *
 * @param input - 可注入的 home 来源。
 * @returns 落点；一条来源都拿不到时 undefined。
 */
export function resolveStateLocation(input: StateLocationInput = {}): StateLocation | undefined {
  const fromProfile = nonEmpty(input.profileHome)
  if (fromProfile !== undefined) {
    return { home: fromProfile, path: stateFilePath(fromProfile), source: 'profile' }
  }
  // 后两条来源走**唯一的 home 口径**（{@link resolveDshHome}：`DSH_HOME` → `~/.dsh`）——
  // 与网关安装目录 / 运行目录 / `auths/` 目录是同一段代码，不会各走各的。
  // 它也可能拿不到（被裁剪过的运行时 / 没有 home 的容器）—— 那时就是真的降级。
  const home = resolveDshHome(input)
  if (home === undefined) return undefined
  const fromEnv = nonEmpty((input.env ?? process.env)['DSH_HOME'])
  return { home, path: stateFilePath(home), source: fromEnv === undefined ? 'default' : 'env' }
}

/** 是不是一份「普通对象」（不是数组、不是 null）。 */
function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把任意值规整成 id 列表（只留非空字符串，去重，保持首次出现的顺序）。 */
export function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/**
 * 读整个状态文件。**任何异常都当「空状态」**，绝不抛。
 *
 * 读之外的成员刻意原样保留（别的插件将来往里加字段也不该被我们抹掉），
 * 所以返回的是 `Record<string, unknown>` 而不是 {@link PluginState}。
 *
 * @param path - 状态文件绝对路径。
 * @returns 解析结果；读不到/解析坏/结构不对时 `{}`。
 */
export function readStateFile(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isDict(parsed) ? parsed : {}
  } catch {
    // 文件不存在、权限不够、JSON 坏、内容是 `[]` 或 `null` …… 一律当「没有记录」。
    return {}
  }
}

/**
 * 读某个 provider 的墓碑。
 *
 * @param path - 状态文件绝对路径。
 * @param providerName - `providers.<name>` 的键名。
 * @returns 提供过的 id 列表；**`undefined` = 没有记录**（与空数组不同义）。
 */
export function readOffered(path: string, providerName: string): string[] | undefined {
  const state = readStateFile(path)
  const providers = state['providers']
  if (!isDict(providers)) return undefined
  const entry = providers[providerName]
  if (!isDict(entry)) return undefined
  const offered = entry['lastOffered']
  if (!Array.isArray(offered)) return undefined
  return normalizeIds(offered)
}

/**
 * 写某个 provider 的墓碑（读-改-写，只动这一个键）。
 *
 * **失败会抛** —— 由调用方决定怎么注明；调用方必须保证「墓碑写不进去」不影响
 * provider 配置本身的写入结果。
 *
 * @param path - 状态文件绝对路径。
 * @param providerName - `providers.<name>` 的键名。
 * @param ids - 迄今提供过的全部 id。
 */
export function writeOffered(path: string, providerName: string, ids: readonly string[]): void {
  const state = readStateFile(path)
  const providers = isDict(state['providers']) ? { ...state['providers'] } : {}
  const previous = providers[providerName]
  // 浅合并：同一个 provider 下的其他字段（将来可能加的）保留，只覆盖 lastOffered。
  const next: Record<string, unknown> = isDict(previous) ? { ...previous } : {}
  next['lastOffered'] = normalizeIds(ids)
  providers[providerName] = next
  const version = typeof state['version'] === 'number' ? state['version'] : STATE_SCHEMA_VERSION
  const payload = { ...state, version, providers }
  mkdirSync(dirname(path), { recursive: true })
  // ★ 必须显式 utf8：默认编码在中文 Windows 上会写坏非 ASCII（id 里就可能有）。
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

/** 一个已经接好线的墓碑（路径 + 读写）。 */
export interface TombstoneHandle {
  /** 状态文件绝对路径。 */
  readonly filePath: string
  /** home 是哪来的。 */
  readonly source: HomeSource
  /** 读：`undefined` = 没有记录。 */
  read(): string[] | undefined
  /** 写：失败会抛。 */
  write(ids: readonly string[]): void
}

/** {@link openTombstone} 的入参。 */
export interface OpenTombstoneOptions extends StateLocationInput {
  /** `providers.<name>` 的键名。 */
  providerName: string
}

/**
 * 把墓碑接到具体路径上。
 *
 * @param options - provider 名与 home 来源。
 * @returns 句柄；**推导不出 home 时 `undefined`**（调用方据此不启用墓碑）。
 */
export function openTombstone(options: OpenTombstoneOptions): TombstoneHandle | undefined {
  const location = resolveStateLocation(options)
  if (location === undefined) return undefined
  const { path } = location
  const { providerName } = options
  return {
    filePath: path,
    source: location.source,
    read: () => readOffered(path, providerName),
    write: (ids: readonly string[]) => { writeOffered(path, providerName, ids) },
  }
}
