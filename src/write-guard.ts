/**
 * 写路径安全网：**备份 → 写入 → 校验 → 回滚**。
 *
 * ## 为什么需要它（这不是假想的风险，是已经发生过的事故）
 *
 * 2026-10-08：一次 `settings.mutate` 返回成功，而 profile 的
 * `cordis.patch.yml` 从 **34 条目 / 63,570 B** 变成 **3 条目 / 661 B**。
 * 写入没有抛错、插件报告"已创建"、配置却已经被截断 —— 而且没有任何环节
 * 发现这件事，坏文件一直留到下一次冷启动才把应用打挂。
 *
 * 当时的姿态是「写入成功即结束」。本模块把那条姿态换成三条铁律。
 *
 * ## 三条铁律
 *
 *   ① **写前备份，且备份必须落在 profile 之外** ——
 *      写进同一个 profile 目录的备份会跟正本一起被同一次故障毁掉；
 *   ② **写后读回并核对条目数** —— 不能只看 mutate 有没有抛错，
 *      "写入成功"与"内容还在"是两件事；
 *   ③ **条目少了立即回滚** —— 恢复优先于报告，先把文件盖回去再说话。
 *
 * ## 为什么判定逻辑是纯函数
 *
 * {@link judgeWrite} 刻意不碰文件系统：它只比较「写入前快照」与「写入后探针」。
 * 这样最容易悄无声息退化的那条规则（"34 → 3 必须判为异常"）可以在单测里直接
 * 断言，不需要真 profile、也不需要真网关 —— 与 `provider-config.ts` 的既有取舍
 * 一致（那一层也不需要 cordis）。
 *
 * ## 回滚为什么是"盖文件"而不是"再写一次 settings"
 *
 * 事故形态是**整份文件被截断**，不是某一个 provider 的值写错。`settings.mutate`
 * 只能恢复一个 provider 的值，盖不回被删掉的另外 31 个条目；而整份盖回能同时
 * 覆盖两种形态。DSH 的 HMR 监听 profile patch（`dsh-hmr/lib/index.js:354`），
 * 所以盖回文件即触发热加载；万一没触发，重启即可。
 *
 * @module dsh-pylon-workbuddy/write-guard
 */

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/**
 * 安全网用到的文件系统子集。
 *
 * 全部注入是为了让「备份失败 ⇒ 不许写」「条目变少 ⇒ 回滚」这些**决策**能在单测里
 * 用内存替身跑完整条路径，包括故障注入 —— 真文件系统做不到"让 copyFile 抛错"。
 */
export interface WriteGuardIO {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  copyFile(from: string, to: string): Promise<void>
  mkdir(path: string): Promise<void>
  listDir(path: string): Promise<string[]>
  remove(path: string): Promise<void>
}

/** 默认实现：真文件系统。 */
export const nodeWriteGuardIO: WriteGuardIO = {
  async readFile(path) { return await readFile(path, 'utf8') },
  async writeFile(path, data) { await writeFile(path, data, 'utf8') },
  async copyFile(from, to) { await copyFile(from, to) },
  async mkdir(path) { await mkdir(path, { recursive: true }) },
  async listDir(path) { return await readdir(path) },
  async remove(path) { await rm(path, { force: true }) },
}

/** 备份目录名；落在 DSH home 之下、profile 目录**之外**。 */
export const BACKUP_DIR_NAME = 'wb2api-write-backups'

/** 默认保留的备份份数（超出后删最旧的）。 */
export const DEFAULT_KEEP_BACKUPS = 20

/**
 * 推导默认备份目录。
 *
 * 取 `home`（`~/.dsh`）而不是 `dir`（`~/.dsh/profiles/<name>`）是刻意的：
 * profile patch 就在 `dir` 里面，备份只有落在它**之外**才不会被同一次事故
 * 一起毁掉 —— 这正是铁律 ① 的全部要点。
 *
 * @param home - `profileContext.home`（DSH 数据根）。
 * @returns 备份目录绝对路径。
 */
export function defaultBackupDir(home: string): string {
  return join(home, BACKUP_DIR_NAME)
}

/**
 * 数一份 profile patch 里有几个 **profile 条目**。
 *
 * ## 为什么不数所有 `- id:`
 *
 * provider 的**模型**也是 `- id:` 的形式（`          - id: cn:space-bunny`，缩进 10）。
 * 把那些也算进来的话，计数会随「网关下架了几个模型」而变 —— 于是 `--rebuild` 在
 * **合法的下架场景**里会让计数变小，被 {@link judgeWrite} 误判成「文件被截断」而回滚。
 * 那样这个命令在下架时就永远用不了。
 *
 * ★ 这个缺陷是 **2026-10-12 实测中发现的**：live 的 patch 顶层 12 条、
 *   把模型 id 一起数则是 34 条 —— 两个口径一开始混用了。
 *
 * ## 口径
 *
 * 匹配**缩进 ≤ 4 的 `- id:`**，正好覆盖两种真实形态：
 *   · 顶层条目（列 0）                    —— `- id: llm-pi-ai`
 *   · `- insert:` 列表里的条目（缩进 4）  —— `    - id: mcp-exa`
 * 并排除配置内容（provider 名缩进 6、模型 id 缩进 10）。
 *
 * ## 为什么用文本行数而不是 YAML 解析
 *
 * 事故形态是"文件被整份重写"，此刻文件未必还是合法 YAML —— 解析器遇到坏文件会
 * 抛错，而我们要的恰恰是"坏文件也能数出它坏了"。
 *
 * @param text - patch 文件全文。
 * @returns profile 条目数（不含 provider 的模型 id）。
 */
export function countPatchEntries(text: string): number {
  let count = 0
  for (const line of text.split(/\r?\n/)) {
    if (/^ {0,4}-\s*id:\s*\S/.test(line)) count += 1
  }
  return count
}

/** 写入前的现场快照。 */
export interface WriteGuardSnapshot {
  /** 备份文件的绝对路径（**在 profile 之外**）。 */
  backupPath: string
  /** 写入前 patch 里的条目数。 */
  entryCount: number
  /** 写入前 patch 的字节数。 */
  bytes: number
}

/** 写入后的读回探针（由调用方从 `settings.describe()` 里取）。 */
export interface WriteGuardProbe {
  /** 读回后 patch 里的条目数；文件读不到时为 undefined。 */
  entryCount?: number
  /** 读回后 providers 字典里有没有我们刚写的那个名字。 */
  providerPresent: boolean
  /** 读回后那个 provider 声明了几个模型。 */
  modelCount: number
}

/** 判定结果。 */
export type WriteVerdict =
  | { ok: true; entryCount: number }
  | { ok: false; reasons: string[]; entryCount?: number }

/**
 * 判定「这次写入是否可信」。
 *
 * 三条规则，任一条不满足即判定异常（调用方据此回滚）：
 *   ① **条目数不能变少** —— 事故形态（34 → 3）由这条兜住；
 *   ② 我们刚写的 provider 必须真的在 providers 字典里；
 *   ③ 它的模型数必须等于我们写进去的数量。
 *
 * 规则 ① 只在"写入后数得到"时生效。读不到文件时**不算通过**，而是记为一条
 * 原因 —— 无法确认与确认无误必须区分开，否则安全网会在最需要它的时刻失效。
 *
 * 条目数**变多**不算异常（别的插件同时在写自己的配置段），只记不拦。
 *
 * @param before - 写入前快照。
 * @param after - 写入后探针。
 * @param expected - 本次写入的期望值。
 * @returns 判定结果。
 */
export function judgeWrite(
  before: WriteGuardSnapshot,
  after: WriteGuardProbe,
  expected: { modelCount: number },
): WriteVerdict {
  const reasons: string[] = []
  if (after.entryCount === undefined) {
    reasons.push(`写入后读不到 profile patch，无法确认条目数（写入前 ${before.entryCount} 条）`)
  } else if (after.entryCount < before.entryCount) {
    reasons.push(`profile patch 条目数变少：写入前 ${before.entryCount} → 写入后 ${after.entryCount}`)
  }
  if (!after.providerPresent) {
    reasons.push('provider 不在 providers 字典里（这次写入没有落地）')
  } else if (after.modelCount !== expected.modelCount) {
    reasons.push(`provider 模型数不符：期望 ${expected.modelCount} → 实际 ${after.modelCount}`)
  }
  if (reasons.length > 0) {
    return after.entryCount === undefined ? { ok: false, reasons } : { ok: false, reasons, entryCount: after.entryCount }
  }
  return { ok: true, entryCount: after.entryCount ?? before.entryCount }
}

/** {@link snapshotPatch} 的入参。 */
export interface WriteGuardOptions {
  /** profile patch 的绝对路径（`profileContext.patchPath`）。 */
  patchPath: string
  /** 备份目录；**必须不在 profile 目录之内**。 */
  backupDir: string
  /** 保留份数上限，超出删最旧的；默认 {@link DEFAULT_KEEP_BACKUPS}。 */
  keep?: number
  /** 时间源，注入以便单测。 */
  now?: () => number
  /** 文件系统，注入以便单测。 */
  io?: WriteGuardIO
}

/** 把毫秒时间戳压成 `20261012-162642` 这种文件系统安全的形式。 */
function compactStamp(ms: number): string {
  const at = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
    + `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
}

/**
 * 写前备份，并返回基线快照。
 *
 * **抛错即意味着"不许写"** —— 调用方拿到异常必须放弃写入，而不是"备份不了就先写"。
 * 这个方向是刻意的：备份失败时继续写的收益是"这次可能成功"，代价是"可能再发生
 * 一次 34 → 3 而没有任何退路"。
 *
 * @param options - patch 路径、备份目录与注入点。
 * @returns 基线快照。
 */
export async function snapshotPatch(options: WriteGuardOptions): Promise<WriteGuardSnapshot> {
  const io = options.io ?? nodeWriteGuardIO
  const now = options.now ?? Date.now
  const text = await io.readFile(options.patchPath)
  await io.mkdir(options.backupDir)
  const entryCount = countPatchEntries(text)
  const backupPath = join(
    options.backupDir,
    `${basename(options.patchPath)}.before-write-${compactStamp(now())}-${entryCount}entries.bak`,
  )
  await io.copyFile(options.patchPath, backupPath)
  await pruneBackups(options, io)
  return { backupPath, entryCount, bytes: Buffer.byteLength(text, 'utf8') }
}

/**
 * 备份保留策略：只留最新 `keep` 份。
 *
 * 备份是**只增不减**的目录，没有这一步就会在 `~/.dsh` 里无限堆积。
 * 清理失败一律吞掉：安全网的第一职责是保住正本，备份目录整理不干净不该
 * 反过来让一次本来能完成的写入失败。
 */
async function pruneBackups(options: WriteGuardOptions, io: WriteGuardIO): Promise<void> {
  const keep = options.keep ?? DEFAULT_KEEP_BACKUPS
  if (keep <= 0) return
  try {
    const prefix = `${basename(options.patchPath)}.before-write-`
    const names = (await io.listDir(options.backupDir))
      .filter(name => name.startsWith(prefix))
      .sort()
    // 文件名内嵌了同样宽度的紧凑时间戳，字典序即时间序。
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      await io.remove(join(options.backupDir, name))
    }
  } catch {
    // 见上：整理备份不该拖垮写入。
  }
}

/**
 * 把备份整份盖回 patch。
 *
 * @param options - patch 路径与注入点。
 * @param snapshot - {@link snapshotPatch} 的返回值。
 */
export async function rollbackPatch(options: WriteGuardOptions, snapshot: WriteGuardSnapshot): Promise<void> {
  const io = options.io ?? nodeWriteGuardIO
  const backup = await io.readFile(snapshot.backupPath)
  await io.writeFile(options.patchPath, backup)
}

/**
 * 探针里 patch 条目数的取法：独立读文件，不复用 `settings.describe()`。
 *
 * 理由：`describe()` 反映的是 Loader **内存里**的组合结果，而事故形态是
 * **磁盘上的文件**被截断。要抓的是后者，就必须读后者。
 *
 * 全程走注入的 `io.readFile`（**不额外调 `fs.access`**）：任何绕过注入去碰真
 * 文件系统的调用都会让这一层在单测里失真 —— 而这一层恰恰是只在事故当天才
 * 真正起作用的那一层。读不到即返回 undefined，交给 {@link judgeWrite} 判成
 * "无法确认"。
 *
 * @param options - patch 路径与注入点。
 * @returns 条目数；文件读不到时 undefined。
 */
export async function probeEntryCount(options: WriteGuardOptions): Promise<number | undefined> {
  const io = options.io ?? nodeWriteGuardIO
  try {
    return countPatchEntries(await io.readFile(options.patchPath))
  } catch {
    return undefined
  }
}
