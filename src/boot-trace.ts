/**
 * 插件**自己**的启动轨迹：`<DSH_HOME>/.wb2api/boot.log`。
 *
 * ## 它解决什么
 *
 * 插件出问题时，宿主的日志分不清三种**完全不同**的沉默：
 *
 * ```
 * ① 模块根本没被 import                      → 一行都没有
 * ② import 了，但 cordis 让插件停在 PENDING   → 只有 `module loaded`
 * ③ 加载了、`apply` 也跑了，但某一步没做      → 只有 `module loaded` + `apply 开始`
 * ```
 *
 * 前两种靠 `index.ts` 顶部那两行 `console.log`（主机可见日志）就能分开；
 * 但第三种——「settings 拿到了没有」「凭据解析出什么」「墓碑读到了几条」——
 * 光看主机日志只能靠猜：`ctx.logger` 的输出在这套 desktop / web 运行形态里
 * **不进** host 的 stdout（见 `index.ts` 模块头那段注释），而 `ensureEditableProvider`
 * 挂在 `setTimeout(0)` 上、又被 `timer.unref()` 放手，没跑完时日志一片空白。
 *
 * 这个文件把「猜」变成「事实」：每一步无论成功、失败还是降级，都留一行。
 *
 * ## 与主机可见日志的分工（**两者都留，不是替代**）
 *
 * | 通道 | 位置 | 回答什么 |
 * |---|---|---|
 * | `console.log('[workbuddy2api] …')` | host stdout | 「插件跑没跑」——宿主日志里看得见 |
 * | `trace('…')` | `<home>/.wb2api/boot.log` | 「跑到哪一步、那一步的结果是什么」 |
 *
 * ## 落盘位置：与 `state.json` **同目录**
 *
 * `<DSH_HOME>/.wb2api/boot.log`（**有点**）—— 与网关自己的运行目录
 * `~/.dsh/wb2api/`（没点）是两个目录，理由见 `plugin-state.ts` 模块头。
 * home 的推导**复用** {@link resolveStateLocation}：`profileContext.home`
 * → 环境变量 `DSH_HOME` → `~/.dsh`，一条都不重复实现，也就不会与墓碑漂移。
 *
 * ## 格式与失败策略
 *
 * · 格式：`<ISO8601 带毫秒带 Z><两个空格><消息>\n`（照抄 dsh-trae 的实测形态）；
 * · **追加**（`appendFileSync`），不清空、不轮转，每次进程启动往后接一段；
 * · ★ **try/catch 全吞** —— 追踪绝不能成为启动失败的原因。目录建不出来、
 *   文件只读、盘满、home 拿不到 …… 一律静默跳过。
 *
 * 只有验收脚本会清空它（重建临时 profile 时）；生产环境从不自动清空 ——
 * 否则「上一次启动发生了什么」正好会在最需要它的时候被这一次抹掉。
 *
 * @module dsh-workbuddy2api/boot-trace
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveStateLocation, STATE_DIR_NAME, type StateLocationInput } from './plugin-state.js'

/** 轨迹文件名。与 `state.json` 同目录（`<DSH_HOME>/.wb2api/`）。 */
export const BOOT_LOG_FILE_NAME = 'boot.log'

/** 时间戳与消息之间的分隔符：**两个空格**（照抄 dsh-trae 的实测格式）。 */
export const BOOT_TRACE_SEPARATOR = '  '

/**
 * 轨迹文件的绝对路径。
 *
 * 目录名刻意用 `plugin-state.ts` 导出的 {@link STATE_DIR_NAME}（而不是再写一遍
 * `'.wb2api'`）：两处必须同目录，写两遍就会在有人改目录名时悄悄分家。
 *
 * @param home - DSH 数据根（`~/.dsh`）。
 * @returns `<home>/.wb2api/boot.log`；`home` 是空白时返回空串。
 */
export function bootLogPath(home: string): string {
  if (home.trim().length === 0) return ''
  return join(home, STATE_DIR_NAME, BOOT_LOG_FILE_NAME)
}

/**
 * 推导轨迹文件的落点。**复用**墓碑那套 home 解析，不另起一条降级链
 * （`profileContext.home` → `DSH_HOME` → `~/.dsh`）。
 *
 * @param input - 可注入的 home 来源（与 {@link resolveStateLocation} 同一套）。
 * @returns 绝对路径；一条来源都拿不到时 `undefined`（调用方据此静默不写）。
 */
export function resolveBootLogPath(input: StateLocationInput = {}): string | undefined {
  const location = resolveStateLocation(input)
  if (location === undefined) return undefined
  return bootLogPath(location.home)
}

/** {@link writeBootTrace} 的可注入点（单测用；生产调用一律走默认值）。 */
export interface BootTraceOptions extends StateLocationInput {
  /** 路径推导。缺省 {@link resolveBootLogPath}。 */
  resolvePath?: ((input: StateLocationInput) => string | undefined) | undefined
  /** 时间源。缺省 `() => new Date()`。 */
  now?: (() => Date) | undefined
}

/**
 * 真的往盘上追一行。
 *
 * **任何异常都吞掉**，返回「写没写成」。调用方（{@link trace}）刻意不暴露这个返回值
 * 给业务路径 —— 一次追踪写失败不该能让任何逻辑分支改变行为。
 *
 * @param message - 消息（不带时间戳、不带换行；内部会补）。
 * @param options - 可注入的 home 来源 / 路径推导 / 时间源。
 * @returns 写成功为 true；拿不到 home、或写失败为 false。
 */
export function writeBootTrace(message: string, options: BootTraceOptions = {}): boolean {
  try {
    const resolvePath = options.resolvePath ?? resolveBootLogPath
    const path = resolvePath(options)
    // home 拿不到 ⇒ 静默不写。这里**不是**异常路径：被裁剪过的运行时 / 没有 home 的
    // 容器就是这么跑的，插件在那样的环境里仍应完整可用，只是少一条轨迹。
    if (path === undefined || path.length === 0) return false
    // 每次调用都保证目录在（home 可能是刚建的、或 state.json 还没写过）。
    mkdirSync(dirname(path), { recursive: true })
    const now = options.now ?? ((): Date => new Date())
    // ★ 必须显式 utf8：默认编码在中文 Windows 上会写坏非 ASCII，而这里的消息全是中文。
    appendFileSync(path, `${now().toISOString()}${BOOT_TRACE_SEPARATOR}${message}\n`, 'utf8')
    return true
  } catch {
    // 故意全吞：追踪绝不成为启动失败的原因（目录不可建、文件只读、盘满、路径非法…）。
    return false
  }
}

/**
 * 记一行启动轨迹。**这是业务代码唯一该调用的入口。**
 *
 * 语义上等价于「尽力而为的 `console.log`，但落在插件自己的目录里」：
 * 没有返回值、不抛、不阻塞、不改变任何控制流。调用点可以像写注释一样随手加，
 * 不必考虑失败分支 —— 这正是它能被放心插在启动路径每一处的理由。
 *
 * @param message - 消息。多行会被原样写出（每行都绑定同一个时间戳），
 *   因此**建议单行**：格式约定是「一行一个时间戳」，多行会让解析变复杂。
 *
 * @example
 * ```ts
 * trace(`apply 开始：provider=${config.providerName}`)
 * trace(`settings: ${settings === undefined ? 'MISSING' : 'acquired'}`)
 * ```
 */
export function trace(message: string): void {
  writeBootTrace(message)
}
