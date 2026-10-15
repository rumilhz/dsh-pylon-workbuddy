#!/usr/bin/env node
/**
 * dsh-pylon-workbuddy 冷启动验收（A3）—— 一条命令、零人工点击。
 *
 * 一次运行按顺序证明四件事：
 *   1. **真 DSH 进程**在一个一次性 `DSH_HOME` 里挂载本插件、拉起网关、读目录，
 *      并把可编辑 provider 写进 profile 的 `cordis.patch.yml`
 *      → 冷启动 #1 的轨迹必须是 `seed: created`（`--keep-profile` 时允许 `present`）；
 *   2. 写进去的条目**形状对**：`providers.workbuddy` 存在、模型数 > 0、
 *      `baseURL` 指向本插件的固定回环端口、顶层仍是 YAML 列表（没被写坏）；
 *   3. 它写的是**这一次的临时 home**（boot.log 的落点就在临时 home 之下，
 *      并且活体 `~/.dsh` 全程没被本脚本写过任何东西）；
 *   4. **二次启动是 no-op**：`seed: present`，且 profile patch 一个字节都没变
 *      （被比对的是 head 与 sha256 —— 见下面「为什么看 head」）。
 *
 * 隔离是**被强制**的，不是"打算这么做"：
 *   · `DSH_HOME = <工作区>/_wb2api-coldstart/home`，每次写之前都重新自检；
 *   · 临时 profile 只 junction **本插件**，绝不 link 活体 profile 的 node_modules
 *     （在那儿跑一次 pnpm 就会写进活体）；
 *   · 先摘 junction、再递归删 profile 目录（递归删一条含 junction 的目录正是
 *     会吃掉源码树的操作）；
 *   · 本脚本启动的每个进程都记账，收尾 `taskkill /PID <pid> /F /T` 连子进程一起杀；
 *     回环端口在结束前复检，仍被占用就报出来，绝不静默放过；
 *   · 网关的**凭证是拷进来的副本**（`--auths`，默认取活体 `~/.dsh/wb2api/auths`），
 *     只读地拷进临时树；本脚本从不写 `~/.dsh` 里任何东西。
 *
 * ## 为什么"patch 未变"要比对 head，而不只是 sha256
 * sha256 是全文件摘录：只要网关或宿主在两次启动之间往 patch 里补一个字节（比如
 * 另一个插件写它自己的段），哈希就变了，而被验的命题其实完好无损 —— 本插件
 * **没有碰** `providers.workbuddy`。所以二次启动的判据是：
 *   · `providers.workbuddy` 那一段的逐字节 head（该段起始 → 文件末）必须与 #1 后完全一致；
 *   · 全文件 sha256 只作为**补充观察**打印（变了会说明原因，不单独判 FAIL）。
 * 这样断言盯的正好是"用户的删减活过重启"这件事本身。
 *
 * ## 用法
 *   <node> tools/coldstart-verify.mjs [--keep-profile] [--skip-restart] [--capture]
 *                                    [--timeout 90] [--port 7869]
 *                                    [--gateway <wb2a-server.exe>] [--auths <dir>]
 *                                    [--force-port] [--help]
 *
 *   --keep-profile   沿用现有临时 profile（不重置 patch、不重建 home）⇒ 首次启动可以是 present
 *   --skip-restart   只验第一次启动（少掉依赖 boot#2 的断言）
 *   --capture        子进程 stdout/stderr 追写到 `_wb2api-coldstart\coldstart-<label>.log`
 *                    （默认 stdio:'ignore' —— 插件自己的 boot.log 才是诊断通道）
 *   --timeout <sec>  每次启动等 seed 的预算（默认 90）
 *   --port <n>       要守护的回环端口（默认 7869；**刻意避开活体网关的 7863**）
 *   --gateway <path> 网关可执行文件；默认探测 `~/.dsh/wb2api/bin/wb2a-server.exe`
 *   --auths <dir>    网关凭证目录；默认 `~/.dsh/wb2api/auths`（找不到就退 2，见下）
 *   --force-port     端口被占时也 taskkill 持有者（默认：报出 PID 后拒绝开始）
 *
 * **退出码**：`0` 全过 · `1` 有断言 FAIL · `2` 参数错或环境不满足
 * （隔离形状不对 / 端口被占 / 缺网关二进制 / 一个凭证都没有）。
 *
 * **写入**：只有 `_wb2api-coldstart\**`（一次性 home + 进程台账 + 可选捕获日志）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

/* ── 1. 参数 ─────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 || argv[index + 1] === undefined ? fallback : argv[index + 1]
}

const HELP = has('help') || argv.includes('-h')
const KEEP_PROFILE = has('keep-profile')
const SKIP_RESTART = has('skip-restart')
const CAPTURE = has('capture')
const FORCE_PORT = has('force-port')
const TIMEOUT_MS = Math.max(10, Number(opt('timeout', '90'))) * 1000
const PORT = Number(opt('port', '7869'))
/** 给子进程的 `DSH_PROFILE`。默认故意给一个**撒谎的旧值**：本工作区踩过这个坑。 */
const DSH_PROFILE_MODE = opt('dsh-profile', 'desktop')

/* ── 2. 路径（全在 scratch 树内；没有任何硬编码盘符） ─────────────────────── */
const PLUGIN_DIR = resolve(import.meta.dirname, '..')
const SCRATCH = resolve(PLUGIN_DIR, '..', '_wb2api-coldstart')
const HOME = join(SCRATCH, 'home')
const PROFILE_NAME = 'zz-wb'
const PROFILE = join(HOME, 'profiles', PROFILE_NAME)
const PATCH = join(PROFILE, 'cordis.patch.yml')
/** 插件自己的目录（题目要求轮询的就是这个：`$DSH_HOME/.wb2api/boot.log`）。 */
const OWN_DIR = join(HOME, '.wb2api')
const TRACE = join(OWN_DIR, 'boot.log')
const STATE_FILE = join(OWN_DIR, 'state.json')
const LEDGER = join(SCRATCH, 'coldstart-pids.json')
/** 网关运行目录（`config.json` / `auths/` / `data/`）—— 一次性，在 scratch 内。 */
const GATEWAY_DIR = join(SCRATCH, 'gateway')
const GATEWAY_CONFIG = join(GATEWAY_DIR, 'config.json')
const DSH_CMD = 'D:\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd'
const COMSPEC = process.env['ComSpec'] ?? 'cmd.exe'
const PLUGIN_PACKAGE = 'dsh-pylon-workbuddy'
/**
 * 插件的**实例 id** —— `src/index.ts` 里 `export const name = 'pylon-workbuddy'`。
 *
 * ★ 与包名**不是**同一个字符串，这是实测踩到的坑：`cordis.patch.yml` 里
 * `- id: <x>` 覆盖的是**实例 id**，写成包名 `dsh-pylon-workbuddy` 时**一条也匹配不上**，
 * 插件照旧用默认配置（端口 7863、namespace 自动探测），而脚本看起来"跑了"。
 */
const PLUGIN_INSTANCE = 'pylon-workbuddy'
const PROVIDER_ID = 'workbuddy'
const SETTINGS_NS = 'llm-pi-ai'

if (HELP) {
  console.log('用法：node tools/coldstart-verify.mjs [--keep-profile] [--skip-restart] [--capture]')
  console.log('       [--timeout <秒>] [--port <端口>] [--gateway <exe>] [--auths <dir>] [--force-port] [--help]')
  console.log('')
  console.log('  --keep-profile  沿用现有临时 profile（首次启动可以是 seed: present）')
  console.log('  --skip-restart  只验第一次启动')
  console.log('  --capture       子进程 stdout/stderr 落 _wb2api-coldstart\\coldstart-<label>.log')
  console.log(`  --timeout <s>   每次启动等 seed 的预算（默认 ${TIMEOUT_MS / 1000}）`)
  console.log(`  --port <n>      要守护的回环端口（默认 ${PORT}）`)
  console.log('  --gateway <p>   网关可执行文件；默认 ~/.dsh/wb2api/bin/wb2a-server.exe')
  console.log('  --auths <dir>   网关凭证目录；默认 ~/.dsh/wb2api/auths')
  console.log('  --force-port    端口被占时 taskkill 持有者（默认拒绝开始并报出 PID）')
  console.log('')
  console.log('退出码：0 全过 · 1 有断言 FAIL · 2 参数错或环境不满足')
  process.exit(0)
}

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`拒绝运行：--port ${opt('port', '')} 不是合法端口。`)
  process.exit(2)
}
if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS <= 0) {
  console.error(`拒绝运行：--timeout ${opt('timeout', '')} 不是合法秒数。`)
  process.exit(2)
}

/* ── 3. 报告 ────────────────────────────────────────────────────────────── */
const checks = []
let failures = 0
function check(name, passed, evidence = '') {
  checks.push({ name, passed, evidence })
  if (!passed) failures += 1
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${evidence === '' ? '' : `  — ${evidence}`}`)
  return passed
}
const info = (message) => console.log(`      ${message}`)
const line = (char = '-', width = 78) => char.repeat(width)
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 任何要打印的文本都先过它：token 绝不到终端。 */
function redact(text) {
  return String(text)
    .replace(/(Bearer\s+)\S+/gi, '$1<redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<redacted-jwt>')
}
const fingerprint = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12)
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/**
 * taskkill / netstat 说的是控制台 OEM 码页（本机 936），不是 UTF-8 ——
 * 必须用对的解码器读它们的字节，失败信息才不是乱码。
 * 没有完整 ICU 的 Node 退到 UTF-8。
 */
const OEM_DECODER = (() => {
  try {
    return new TextDecoder('gbk')
  } catch {
    return undefined
  }
})()
function decodeOem(output) {
  if (typeof output === 'string') return output
  if (output === null || output === undefined) return ''
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output)
  return OEM_DECODER === undefined ? bytes.toString('utf8') : OEM_DECODER.decode(bytes)
}

/* ── 4. 隔离自检（在一切动作之前，且每次写之前都会再走一遍） ──────────────── */
const REAL_HOME = resolve(homedir(), '.dsh')
function assertIsolation() {
  if (resolve(HOME) === REAL_HOME || REAL_HOME.startsWith(resolve(HOME) + sep)) {
    console.error(`拒绝运行：DSH_HOME(${HOME}) 与真实 home(${REAL_HOME}) 重叠。`)
    process.exit(2)
  }
  if (basename(HOME) !== 'home' || basename(SCRATCH) !== '_wb2api-coldstart') {
    console.error(`拒绝运行：临时 home 的形状不对（${HOME}）—— 期望 <工作区>\\_wb2api-coldstart\\home。`)
    process.exit(2)
  }
  if (!resolve(PROFILE).startsWith(resolve(HOME) + sep)) {
    console.error(`拒绝运行：profile 不在临时 home 之内（${PROFILE}）。`)
    process.exit(2)
  }
  if (!resolve(GATEWAY_DIR).startsWith(resolve(SCRATCH) + sep)) {
    console.error(`拒绝运行：网关运行目录不在 scratch 之内（${GATEWAY_DIR}）。`)
    process.exit(2)
  }
}
assertIsolation()

const REAL_GATEWAY_ROOT = join(REAL_HOME, 'wb2api')
const DEFAULT_GATEWAY_BIN = join(REAL_GATEWAY_ROOT, 'bin', 'wb2a-server.exe')
const DEFAULT_AUTHS = join(REAL_GATEWAY_ROOT, 'auths')
const GATEWAY_BIN = resolve(opt('gateway', DEFAULT_GATEWAY_BIN))
const AUTHS_SRC = resolve(opt('auths', DEFAULT_AUTHS))

console.log(line('='))
console.log(`dsh-pylon-workbuddy 冷启动验收（自动化）  ${new Date().toISOString()}`)
console.log(line('='))
info(`node            ${process.version}  (${process.execPath})`)
info(`插件目录        ${PLUGIN_DIR}`)
info(`临时 DSH_HOME   ${HOME}`)
info(`临时 profile    ${PROFILE_NAME}  (provider=${PROVIDER_ID} · namespace=${SETTINGS_NS})`)
info(`活体 home       ${REAL_HOME} —— 本脚本只从中**读**二进制与凭证副本，绝不写`)
info(`dsh 启动器      ${DSH_CMD}${existsSync(DSH_CMD) ? '' : '  ← 不存在！'}`)
console.log(line())

/* ── 5. 进程台账 + 端口卫生 ─────────────────────────────────────────────── */
function readLedger() {
  try {
    const parsed = JSON.parse(readFileSync(LEDGER, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((entry) => Number.isInteger(entry?.pid)) : []
  } catch {
    return []
  }
}
function writeLedger(entries) {
  try {
    writeFileSync(LEDGER, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  } catch {
    // 台账是便利设施，永远不该成为一次运行失败的原因
  }
}
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
function killTree(pid) {
  const run = spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true })
  // 拼的是 **Buffer**，不是 `${stdout}`：模板插值会先用 UTF-8 把 OEM 字节解坏，
  // 之后再好的解码器也救不回来（实测就是这么出乱码的）。
  const bytes = Buffer.concat([run.stdout ?? Buffer.alloc(0), run.stderr ?? Buffer.alloc(0)])
  const text = decodeOem(bytes).trim().replace(/\s+/g, ' ')
  return { status: run.status, text }
}
function portOwners(port) {
  const run = spawnSync('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true })
  const stdout = decodeOem(run.stdout)
  if (run.status !== 0 || stdout === '') return []
  const pids = new Set()
  for (const row of stdout.split(/\r?\n/)) {
    if (!row.includes('LISTENING')) continue
    const columns = row.trim().split(/\s+/)
    if (columns.length < 5) continue
    if (!(columns[1] ?? '').endsWith(`:${port}`)) continue
    const pid = Number(columns[4])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}
function portFree(port) {
  return new Promise((done) => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.once('listening', () => probe.close(() => done(true)))
    probe.listen(port, '127.0.0.1')
  })
}

/** 只杀**本脚本上一次运行**留下的活进程（绝不杀外来进程）。 */
function reapLedger() {
  const alive = readLedger().filter((entry) => isAlive(entry.pid))
  if (alive.length > 0) {
    info(`清理上次运行残留的进程：${alive.map((entry) => `${entry.pid}(${entry.label ?? '?'})`).join(' ')}`)
    for (const entry of alive) {
      const result = killTree(entry.pid)
      info(`  taskkill /PID ${entry.pid} /F /T → exit=${result.status}${result.text === '' ? '' : `  ${redact(result.text).slice(0, 160)}`}`)
    }
  }
  writeLedger([])
  return alive.length
}

const liveChildren = new Set()
function trackChild(child, label) {
  liveChildren.add(child.pid)
  writeLedger([...readLedger().filter((entry) => isAlive(entry.pid)), { pid: child.pid, label, at: new Date().toISOString() }])
}
function untrackChild(pid) {
  liveChildren.delete(pid)
  writeLedger(readLedger().filter((entry) => entry.pid !== pid))
}
function killAllOurChildren(reason) {
  for (const pid of [...liveChildren]) {
    if (!isAlive(pid)) {
      liveChildren.delete(pid)
      continue
    }
    const result = killTree(pid)
    console.log(`      收尾(${reason})：taskkill /PID ${pid} /F /T → exit=${result.status}`)
    untrackChild(pid)
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n收到 ${signal}，收尾…`)
    killAllOurChildren(signal)
    process.exit(130)
  })
}

async function stopChild(child, label) {
  if (child === undefined) return true
  const pid = child.pid
  const result = killTree(pid)
  const note = result.status === 0 ? '（进程树已终止）' : `  ${redact(result.text).slice(0, 160)}`
  console.log(`      停 ${label}：taskkill /PID ${pid} /F /T → exit=${result.status}${note}`)
  untrackChild(pid)
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await portFree(PORT)) return true
    await sleep(250)
  }
  const owners = portOwners(PORT)
  console.log(`🔴 ${label} 停掉后端口 ${PORT} 仍被占用：PID ${owners.join(', ') || '(netstat 没报出持有者)'}`)
  for (const owner of owners) {
    if (owner === pid || FORCE_PORT) {
      const extra = killTree(owner)
      console.log(`   ← 补刀 taskkill /PID ${owner} /F /T → exit=${extra.status}`)
    }
  }
  await sleep(500)
  return await portFree(PORT)
}

/* ── 6. boot.log 轮询（250ms + 行游标；断前缀，不断行数） ────────────────── */
function traceLines() {
  if (!existsSync(TRACE)) return []
  return readFileSync(TRACE, 'utf8').split(/\r?\n/).filter((row) => row.trim() !== '')
}
const SEED_RE = /seed:\s*([a-z-]+)/
/**
 * 一条 `seed:` 行是不是**结局**（而不是 `seed: start` / `seed: 已排入 setTimeout(0)`）。
 *
 * ★ 这是个实测踩到的坑：`seed: start（…）` 也匹配 `SEED_RE`，于是"第一条 seed 行"
 * 判据会在插件**刚开始**写配置时就返回，把 `kind=start` 当成结局（本脚本第一版
 * 就因此把一次**真的 created** 报成了 FAIL）。真正的结局行只有 `seed: <kind>`，
 * 形态是 `seed: created ns=llm-pi-ai` / `seed: failed` / `seed: skipped`。
 */
const SEED_OUTCOME_RE = /seed:\s*(?!start\b|已排入|跳过|threw\b)[a-z-]+/
/** 从 `seed:` 行里抠出锚点。文案改了这里要同步改（否则断言会静默变 unknown）。 */
function parseSeed(row) {
  const kind = SEED_RE.exec(row)?.[1] ?? 'unknown'
  const ns = /\bns=(\S+)/.exec(row)?.[1]
  const note = /（(.+?)）/.exec(row)?.[1]
  return { kind, ns, note, raw: row }
}
/** `seed: created` 之外，那一步**为什么没成**也在这两行里：`directory:` / `tombstone:`。 */
function lastTraceMatching(re) {
  return traceLines().filter((row) => re.test(row)).pop()
}

/**
 * 等到 boot.log 从第 `seen` 行起出现一条 `seed:` 行。
 * 子进程先退出就直接失败 —— 死进程永远不会 seed。
 */
async function awaitSeed(child, seen, label) {
  const started = Date.now()
  const fresh = []
  let cursor = seen
  for (;;) {
    const all = traceLines()
    if (all.length > cursor) {
      fresh.push(...all.slice(cursor))
      cursor = all.length
    }
    const seedRow = [...fresh].reverse().find((row) => SEED_OUTCOME_RE.test(row))
    if (seedRow !== undefined) return { seed: parseSeed(seedRow), fresh, seen: cursor, elapsed: Date.now() - started }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `${label} 在写出 seed 之前就退出了（exitCode=${child.exitCode} signal=${child.signalCode}）—— `
          + `boot.log 新增 ${fresh.length} 行${CAPTURE ? '，见 _wb2api-coldstart 下的捕获日志' : '（加 --capture 可看到子进程输出）'}：\n`
          + fresh.map((row) => `        ${redact(row)}`).join('\n'),
      )
    }
    if (Date.now() - started > TIMEOUT_MS) {
      throw new Error(
        `${label} 等待 seed 超时（${seconds(TIMEOUT_MS)}）。boot.log 新增 ${fresh.length} 行：\n`
          + (fresh.length === 0
            ? '        (没有任何新增行 —— 插件可能根本没激活)'
            : fresh.map((row) => `        ${redact(row)}`).join('\n')),
      )
    }
    await sleep(250)
  }
}

/* ── 7. 起进程 ──────────────────────────────────────────────────────────── */
async function startDsh(label) {
  const env = { ...process.env, DSH_HOME: HOME, DSH_NODE: process.execPath }
  if (DSH_PROFILE_MODE === 'unset') delete env['DSH_PROFILE']
  else env['DSH_PROFILE'] = DSH_PROFILE_MODE
  let stdio = 'ignore'
  let fd
  if (CAPTURE) {
    fd = openSync(join(SCRATCH, `coldstart-${label}.log`), 'a')
    stdio = ['ignore', fd, fd]
  }
  // Windows 上 `.cmd` 已经不能被 spawn 直接执行；必须走 cmd.exe。
  // `cmd /d /s /c ""<launcher>" …"` 是 Node 自己 `shell: true` 用的形态 —— 而且
  // **必须带 `windowsVerbatimArguments`**，否则 libuv 会把内层引号转义成 `\"`，
  // cmd.exe 把它读成字面反斜杠，回一句 "The filename, directory name, or volume
  // label syntax is incorrect."，进程 0.3 秒就退出（实测，不是猜的）。
  const inner = `"${DSH_CMD}" --profile ${PROFILE_NAME} --no-open --port 0`
  const child = spawn(COMSPEC, ['/d', '/s', '/c', `"${inner}"`], {
    cwd: SCRATCH,
    env,
    stdio,
    windowsHide: true,
    windowsVerbatimArguments: true,
  })
  if (fd !== undefined) closeSync(fd)
  trackChild(child, label)
  return child
}

/* ── 8. patch 的结构化读法（纯缩进解析，不引 YAML 依赖） ─────────────────── */
const indentOf = (row) => row.length - row.trimStart().length
const isBlank = (row) => row.trim() === '' || row.trimStart().startsWith('#')

/** `key:` 所在块的 `[start, end)`，按缩进判边界。 */
function blockEnd(rows, keyIndex, keyIndent) {
  for (let i = keyIndex + 1; i < rows.length; i += 1) {
    if (isBlank(rows[i])) continue
    if (indentOf(rows[i]) <= keyIndent) return i
  }
  return rows.length
}

/**
 * 找 `providers.<id>` 并数它声明了几个模型。
 *
 * 结构性读法而不是 grep：`providers:` 这个词在文件里可能出现多次（每一条
 * `- id: llm-pi-ai` 都有自己的那一层），grep 会数错。
 *
 * @returns `{ namespace, topLevelEntries, found, models, baseUrl, blockStart }`；
 *   `blockStart` 是 provider 段起始行号（第 1 行 = 1），"head 没变"那条断言要用。
 */
function readProviderBlock(text, providerId) {
  const rows = text.split(/\r?\n/)
  const result = {
    namespace: undefined,
    topLevelEntries: rows.filter((row) => /^- /.test(row)).length,
    providerId,
    found: false,
    models: 0,
    baseUrl: undefined,
    api: undefined,
    apiKeyEnv: undefined,
    blockStart: undefined,
  }
  const nsRow = rows.find((row) => /^-\s+id:\s*\S+/.test(row))
  if (nsRow !== undefined) result.namespace = /^-\s+id:\s*(\S+)/.exec(nsRow)?.[1]
  for (let i = 0; i < rows.length; i += 1) {
    const match = /^(\s*)providers:\s*$/.exec(rows[i])
    if (match === null) continue
    const providersIndent = match[1].length
    const providersEnd = blockEnd(rows, i, providersIndent)
    for (let j = i + 1; j < providersEnd; j += 1) {
      const key = /^(\s*)([^\s#][^:]*):\s*$/.exec(rows[j])
      if (key === null || key[1].length <= providersIndent || key[2].trim() !== providerId) continue
      result.found = true
      result.blockStart = j + 1
      const providerIndent = key[1].length
      const providerEnd = blockEnd(rows, j, providerIndent)
      for (let k = j + 1; k < providerEnd; k += 1) {
        const base = /^(\s*)baseURL:\s*(\S+)\s*$/.exec(rows[k])
        if (base !== null && base[1].length > providerIndent) result.baseUrl = base[2]
        const api = /^(\s*)api:\s*(\S+)\s*$/.exec(rows[k])
        if (api !== null && api[1].length > providerIndent) result.api = api[2]
        const keyEnv = /^(\s*)apiKeyEnv:\s*(\S+)\s*$/.exec(rows[k])
        if (keyEnv !== null && keyEnv[1].length > providerIndent) result.apiKeyEnv = keyEnv[2]
        const modelsKey = /^(\s*)models:\s*$/.exec(rows[k])
        if (modelsKey === null || modelsKey[1].length <= providerIndent) continue
        const modelsIndent = modelsKey[1].length
        const modelsEnd = blockEnd(rows, k, modelsIndent)
        for (let m = k + 1; m < modelsEnd; m += 1) {
          if (indentOf(rows[m]) >= modelsIndent && /^\s*-\s+id:\s*\S+/.test(rows[m])) result.models += 1
        }
      }
      return result
    }
  }
  return result
}

/** 从 provider 段起始行到文件末 —— 二次启动比对的**语义单位**。 */
function providerHead(text, blockStart) {
  if (blockStart === undefined) return undefined
  return text.split(/\r?\n/).slice(blockStart - 1).join('\n')
}

/**
 * 5 秒收敛判：文件可能还在写，直接算会拿到中间态。
 * 连续两次读到同一个 sha256 才认为写完了。
 */
async function stableHash(path, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs
  let previous = sha256File(path)
  while (Date.now() < deadline) {
    await sleep(250)
    const next = sha256File(path)
    if (next === previous) return next
    previous = next
  }
  return previous
}

/* ── 9. 预检：dsh 启动器 / 网关二进制 / 凭证 / 端口 ─────────────────────── */
console.log('准备：')
const reaped = reapLedger()
info(reaped === 0 ? '没有上次运行残留的进程' : `已清理 ${reaped} 个上次运行的进程`)

if (!existsSync(DSH_CMD)) {
  console.log(`🔴 dsh 启动器不存在：${DSH_CMD}`)
  console.log('结论：未开始即中止（没有真 DSH 就无所谓"冷启动"）。')
  process.exit(2)
}
if (!existsSync(GATEWAY_BIN)) {
  console.log(`🔴 找不到网关可执行文件：${GATEWAY_BIN}`)
  info('provider 的创建必须先拉到 /v1/models；没有网关二进制，这一轮只可能走到 seed: failed。')
  info('先装一次网关（活体 dsh 里执行 /wb2api-setup），或用 --gateway <path> 指定。')
  console.log('结论：未开始即中止（环境不满足，不是插件的问题）。')
  process.exit(2)
}
const authFiles = (() => {
  try {
    return readdirSync(AUTHS_SRC).filter((name) => name.toLowerCase().endsWith('.json'))
  } catch {
    return []
  }
})()
if (authFiles.length === 0) {
  console.log(`🔴 凭证目录里一个 *.json 都没有：${AUTHS_SRC}`)
  info('网关没有账号时 /v1/models 返回 {"data":[]}（实测），provider 就会以 0 个模型创建。')
  info('先登录一次（活体 dsh 里执行 /wb2api-setup 或 /wb2api-login），或用 --auths <dir> 指定。')
  console.log('结论：未开始即中止（环境不满足，不是插件的问题）。')
  process.exit(2)
}
info(`网关二进制      ${GATEWAY_BIN}`)
info(`凭证来源        ${AUTHS_SRC}（${authFiles.length} 份 —— 只往临时树里拷副本，不打印文件名与内容）`)

if (!(await portFree(PORT))) {
  const owners = portOwners(PORT)
  console.log(`🔴 端口 ${PORT} 已被占用：PID ${owners.join(', ') || '(netstat 没报出持有者)'}`)
  info('这不是本脚本启动的进程。先自己确认它是谁，再决定；或加 --force-port 让本脚本 taskkill 它。')
  if (!FORCE_PORT) {
    console.log('结论：未开始即中止（端口不干净会伪装成插件失败）。')
    process.exit(2)
  }
  for (const owner of owners) {
    const result = killTree(owner)
    info(`--force-port：taskkill /PID ${owner} /F /T → exit=${result.status}`)
  }
  await sleep(750)
  if (!(await portFree(PORT))) {
    console.log(`🔴 --force-port 之后端口 ${PORT} 仍然被占用，中止。`)
    process.exit(2)
  }
}
info(`端口 ${PORT} 空闲`)

/* ── 10. 一次性网关运行目录（config.json + auths 副本） ────────────────── */
mkdirSync(join(GATEWAY_DIR, 'auths'), { recursive: true })
mkdirSync(join(GATEWAY_DIR, 'data'), { recursive: true })
for (const name of authFiles) copyFileSync(join(AUTHS_SRC, name), join(GATEWAY_DIR, 'auths', name))
if (!KEEP_PROFILE || !existsSync(GATEWAY_CONFIG)) {
  writeFileSync(
    GATEWAY_CONFIG,
    `${JSON.stringify({ listen: `127.0.0.1:${PORT}`, api_key: `coldstart-${fingerprint(SCRATCH)}`, auth_dir: './auths', state_file: './data/state.json' }, null, 2)}\n`,
    'utf8',
  )
}
info(`网关运行目录    ${GATEWAY_DIR}（config.json 监听 ${PORT} · auths ${authFiles.length} 份副本 · 整个目录收尾时随 scratch 一起删）`)

/* ── 11. 建临时 profile（顺序不能变） ──────────────────────────────────── */
mkdirSync(OWN_DIR, { recursive: true })
const junction = join(PROFILE, 'node_modules', PLUGIN_PACKAGE)
/**
 * `--keep-profile` 只有在**形状完整**时才是"沿用"：上一次运行若以成功收尾，
 * 整个 scratch 树是被删掉的，此时 `--keep-profile` 其实等于"重新建一次"。
 * 少了这层判断就会在 `symlinkSync` 上抛 ENOENT（父目录还不存在）——
 * 本脚本第一版就是这样：开 `--keep-profile` 直接崩在 Node 栈上。
 */
const reusable =
  KEEP_PROFILE
  && existsSync(join(PROFILE, 'cordis.yml'))
  && existsSync(join(PROFILE, 'package.json'))
  && existsSync(PATCH)
if (KEEP_PROFILE && !reusable) {
  info('--keep-profile：临时 profile 不存在或形状不完整（上次以成功收尾时会整个删掉）⇒ 本次按重建处理')
}
if (!reusable) {
  // ★ 先摘 junction，再递归删目录：递归删一条含 junction 的目录正是会吃掉源码树的操作。
  if (existsSync(junction)) rmSync(junction, { force: true, recursive: false })
  rmSync(PROFILE, { recursive: true, force: true })
  mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })
  if (!existsSync(join(PLUGIN_DIR, 'package.json'))) {
    console.log('🔴 插件目录在重建临时 profile 后不见了 —— 立刻中止。')
    process.exit(2)
  }
  writeFileSync(join(PROFILE, 'cordis.yml'), '# scratch profile for the dsh-pylon-workbuddy cold start — an empty entry list.\n[]\n', 'utf8')
  writeFileSync(
    join(PROFILE, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${PROFILE_NAME}`,
        private: true,
        dependencies: { [PLUGIN_PACKAGE]: `link:${PLUGIN_DIR.replaceAll('\\', '/')}` },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', `@deepseek-ai/${SETTINGS_NS}`, PLUGIN_PACKAGE] } },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  // 必须是**顶层 YAML 数组**（解析成 null 会被 boot 拒绝）。两条目：
  //   ① 数据面 namespace 先放一个空 `providers`，等插件把 workbuddy 写进来。
  //      它的 `name` 必须是带 scope 的真包名，不带 scope 会在解析期直接报错。
  //   ② `- id: pylon-workbuddy` 覆盖**实例配置**。★ 这里的 `id` 是**实例 id**
  //      （= 插件包里 `export const name`，**不是**包名 `dsh-pylon-workbuddy`）：
  //      写成包名等于什么也没覆盖（本脚本第一版就是这么错的）。
  //   ★ **不要**再手写 `- insert:` —— profile 的 `dsh.profile.bundles` 已经把插件
  //     挂进组合，插件的 `cordis.patch.yml` 也自带一条 insert；再写一条实测会让插件
  //     **mount 两次**（boot.log 里每个锚点出现两遍，两份配置各创建一次 provider）。
  writeFileSync(
    PATCH,
    [
      '# scratch profile patch (user layer) — 本插件把 provider 条目写在这里',
      `- id: ${SETTINGS_NS}`,
      `  name: "@deepseek-ai/${SETTINGS_NS}"`,
      '  config:',
      '    providers: {}',
      '# 覆盖实例配置：端口刻意避开活体网关的 7863，运行目录全部落在 scratch 内',
      `- id: ${PLUGIN_INSTANCE}`,
      '  config:',
      `    binaryPath: ${JSON.stringify(GATEWAY_BIN.replaceAll('\\', '/'))}`,
      `    workingDir: ${JSON.stringify(GATEWAY_DIR.replaceAll('\\', '/'))}`,
      `    listenPort: ${PORT}`,
      `    baseURL: http://127.0.0.1:${PORT}/v1`,
      '    autoStart: true',
      `    providerNamespace: ${SETTINGS_NS}`,
      `    writeBackupDir: ${JSON.stringify(join(SCRATCH, 'write-backups').replaceAll('\\', '/'))}`,
      '',
    ].join('\n'),
    'utf8',
  )
  symlinkSync(PLUGIN_DIR, junction, 'junction')
  rmSync(STATE_FILE, { force: true })
  info(`临时 profile 已重建：cordis.yml=[] · package.json(bundles=base+${SETTINGS_NS}+${PLUGIN_PACKAGE}) · 只 junction 本插件`)
} else {
  info('--keep-profile：沿用现有临时 profile（不重置 patch、不重建 home）')
  mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })
  if (!existsSync(junction)) symlinkSync(PLUGIN_DIR, junction, 'junction')
}

writeFileSync(TRACE, '', 'utf8')
const patchTextBefore1 = readFileSync(PATCH, 'utf8')
const patchBytesBefore1 = Buffer.byteLength(patchTextBefore1, 'utf8')
const patchHashBefore1 = sha256File(PATCH)
info('boot.log 已清空（本次运行从零开始）')
info(`写前 patch：${patchBytesBefore1} B · sha256 ${patchHashBefore1.slice(0, 16)} · 顶层条目 ${readProviderBlock(patchTextBefore1, PROVIDER_ID).topLevelEntries}`)
console.log(line())

/* ── 12. 冷启动 #1 ─────────────────────────────────────────────────────── */
const runStarted = Date.now()
let child1
let seed1
let patch1
let patchText1
let block1
{
  console.log(`[1/2] 冷启动 #1：${DSH_CMD} --profile ${PROFILE_NAME} --no-open --port 0`)
  info(`(DSH_HOME=${HOME} · DSH_PROFILE=${DSH_PROFILE_MODE} · stdio=${CAPTURE ? 'capture' : 'ignore'} · 端口 ${PORT})`)
  const bootStarted = Date.now()
  child1 = await startDsh('boot1')
  info(`已启动 cmd.exe PID ${child1.pid}（子进程树用 taskkill /T 收）`)
  let failure
  try {
    // 断前缀、不断行数：Trae 的 boot.log 从"六行"长到 9 行，版本间只会加锚点。
    const waited = await awaitSeed(child1, 0, '冷启动 #1')
    seed1 = waited.seed
    info(`boot.log 新增 ${waited.fresh.length} 行（${seconds(waited.elapsed)} 后出现 seed 行）：`)
    for (const row of waited.fresh) info(`  ${redact(row)}`)
  } catch (error) {
    failure = error
    check('冷启动 #1 写出了 seed 行（插件真的跑到了写配置那一步）', false, error instanceof Error ? error.message : String(error))
  }

  if (failure === undefined) {
    check(
      `seed 行是 created${KEEP_PROFILE ? '（或 present，keep 模式）' : ''}`,
      seed1.kind === 'created' || (KEEP_PROFILE && seed1.kind === 'present'),
      `kind=${seed1.kind}${seed1.ns === undefined ? '' : ` · ns=${seed1.ns}`}${seed1.note === undefined ? '' : ` · ${seed1.note}`}`,
    )
    const directoryRow = lastTraceMatching(/directory: /)
    if (seed1.kind !== 'created' && directoryRow !== undefined) info(`为什么不是 created：${redact(directoryRow)}`)

    // 落点自证：轨迹文件本身就在这一次的临时 home 之下。
    check(
      'boot.log 落在本次临时 home 之下（隔离证据）',
      resolve(TRACE).toLowerCase().startsWith(resolve(HOME).toLowerCase() + sep),
      `${TRACE}（插件目录与本 home 同源）`,
    )
    check(
      'state.json（墓碑）也落在本次临时 home 之下',
      !existsSync(STATE_FILE) || resolve(STATE_FILE).toLowerCase().startsWith(resolve(HOME).toLowerCase() + sep),
      existsSync(STATE_FILE) ? `${STATE_FILE}（${statSync(STATE_FILE).size} B）` : '本轮没写（present 且无记录时正常）',
    )

    patchText1 = readFileSync(PATCH, 'utf8')
    const bytesAfter1 = Buffer.byteLength(patchText1, 'utf8')
    block1 = readProviderBlock(patchText1, PROVIDER_ID)
    info(`写后 patch：${patchBytesBefore1} B → ${bytesAfter1} B · 顶层条目 ${block1.topLevelEntries} · 命名空间 ${block1.namespace ?? '?'}`)
    check(
      `patch 里出现 providers.${PROVIDER_ID}`,
      block1.found,
      `providers.${PROVIDER_ID} ${block1.found ? '存在' : '缺失'}${block1.blockStart === undefined ? '' : `（第 ${block1.blockStart} 行起）`}`,
    )
    check(`providers.${PROVIDER_ID} 的模型数 > 0`, block1.models > 0, `${block1.models} 个模型`)
    check(
      'baseURL 指向本次临时配置的回环端口',
      block1.baseUrl === `http://127.0.0.1:${PORT}/v1`,
      `${block1.baseUrl ?? '(缺失)'}`,
    )
    // 形状：pi-ai 只认自己那几个 `api` 家族；少了 apiKeyEnv 模型请求就没有凭据来源。
    check(
      `条目形状（api + apiKeyEnv）与 pi-ai 对得上`,
      block1.api === 'openai-completions' && (block1.apiKeyEnv ?? '').length > 0,
      `api=${block1.api ?? '(缺失)'} · apiKeyEnv=${block1.apiKeyEnv ?? '(缺失)'}`,
    )
    check('patch 顶层仍是 YAML 列表（未被写坏）', block1.topLevelEntries >= 1, `${block1.topLevelEntries} 个顶层条目`)

    patch1 = await stableHash(PATCH)
    check(
      KEEP_PROFILE ? 'patch 可读且非空' : 'boot#1 真的写了文件（不是"created 却空转"）',
      KEEP_PROFILE ? readFileSync(PATCH).length > 0 : patchHashBefore1 !== patch1,
      `写前 sha256 ${patchHashBefore1.slice(0, 16)} → 写后 ${patch1.slice(0, 16)} · ${readFileSync(PATCH).length} B`,
    )
  }
  console.log(`      冷启动 #1 用时 ${seconds(Date.now() - bootStarted)}`)
}

/* ── 13. 停 #1 → 端口必须释放 ───────────────────────────────────────────── */
if (child1 !== undefined) {
  const released = await stopChild(child1, '冷启动 #1')
  check(`停掉 #1 后端口 ${PORT} 已释放`, released, released ? '空闲' : `仍被 PID ${portOwners(PORT).join(', ') || '?'} 占用`)
}

/* ── 14. 冷启动 #2：no-op 验证 ─────────────────────────────────────────── */
if (failures === 0 && !SKIP_RESTART && patch1 !== undefined) {
  console.log(line())
  console.log('[2/2] 冷启动 #2（同一 profile、同一 home，只验证"二次启动是 no-op"）')
  const bootStarted = Date.now()
  const bytesBefore2 = readFileSync(PATCH).length
  const head1 = providerHead(patchText1, block1?.blockStart)
  const mtimeBefore2 = statSync(PATCH).mtimeMs
  const seen = traceLines().length
  const child2 = await startDsh('boot2')
  info(`已启动 cmd.exe PID ${child2.pid}`)
  let failure
  try {
    const waited = await awaitSeed(child2, seen, '冷启动 #2')
    info(`boot.log 新增 ${waited.fresh.length} 行（${seconds(waited.elapsed)} 后出现 seed 行）：`)
    for (const row of waited.fresh) info(`  ${redact(row)}`)
    check('二次启动是 seed: present（一个字都没写）', waited.seed.kind === 'present', `kind=${waited.seed.kind}${waited.seed.note === undefined ? '' : ` · ${waited.seed.note}`}`)
    // 「#2 什么都没写」这件事必须在**第二个进程真的起来了**的前提下才算数：
    // 否则一个启动即崩的第二次启动也会让 patch 保持原样，看起来像 no-op。
    check('第二次启动真的写了 boot.log（不是"没起来所以没写"）', waited.fresh.length > 0, `新增 ${waited.fresh.length} 行`)
  } catch (error) {
    failure = error
    check('二次启动是 seed: present（一个字都没写）', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
  }
  const hashAfter2 = await stableHash(PATCH)
  const patchText2 = readFileSync(PATCH, 'utf8')
  const block2 = readProviderBlock(patchText2, PROVIDER_ID)
  const head2 = providerHead(patchText2, block2.blockStart)
  const bytesAfter2 = readFileSync(PATCH).length
  check(
    `providers.${PROVIDER_ID} 那一段逐字节未变（用户的删减活过重启）`,
    head1 !== undefined && head2 !== undefined && head1 === head2,
    head1 === undefined || head2 === undefined
      ? 'provider 段缺失，无法比对'
      : `head ${fingerprint(head1)}（${head1.length} 字符）→ ${fingerprint(head2)}（${head2.length} 字符）`,
  )
  check(
    `providers.${PROVIDER_ID} 的模型数未变`,
    block1 !== undefined && block1.models === block2.models,
    `#1 后 ${block1?.models ?? '?'} → #2 后 ${block2.models}`,
  )
  // 全文件 sha256 只作补充观察：宿主/别的插件补一个字节也会让它变，那不是本插件的错。
  info(
    hashAfter2 === patch1
      ? `全文件 sha256 未变（${patch1.slice(0, 16)}）· ${bytesBefore2} B → ${bytesAfter2} B · mtime ${mtimeBefore2 === statSync(PATCH).mtimeMs ? '未变' : '变了'}`
      : `全文件 sha256 变了（${patch1.slice(0, 16)} → ${hashAfter2.slice(0, 16)}，但 provider 段未变 —— 说明改动落在别处；${bytesBefore2} B → ${bytesAfter2} B）`,
  )
  console.log(`      冷启动 #2 用时 ${seconds(Date.now() - bootStarted)}`)
  const released2 = await stopChild(child2, '冷启动 #2')
  check(`停掉 #2 后端口 ${PORT} 已释放`, released2, released2 ? '空闲' : `仍被 PID ${portOwners(PORT).join(', ') || '?'} 占用`)
} else if (SKIP_RESTART) {
  console.log(line())
  info('--skip-restart：跳过二次启动')
} else {
  console.log(line())
  info('boot #1 有失败项 ⇒ 不再做二次启动（先把第一次弄对）')
}

/* ── 15. 收尾：残留进程 + 端口 + 清理 ──────────────────────────────────── */
const stragglers = [...liveChildren].filter(isAlive)
if (stragglers.length > 0) {
  console.log(`🔴 仍有本脚本启动的进程活着：${stragglers.join(', ')} —— 正在补杀`)
  killAllOurChildren('收尾')
}
const finalOwners = portOwners(PORT)
if (finalOwners.length > 0) {
  console.log(`🔴 结束前端口 ${PORT} 仍被占用：PID ${finalOwners.join(', ')}（这会让下一次运行失败，请手动处理）`)
}
const seedCreatedCount = existsSync(TRACE) ? traceLines().filter((row) => /seed:\s*created/.test(row)).length : 0

console.log(line('='))
console.log('结论')
console.log(line('='))
const passed = checks.filter((entry) => entry.passed).length
for (const entry of checks) if (!entry.passed) console.log(`  FAIL  ${entry.name}  — ${entry.evidence}`)
const ok = failures === 0
if (ok) {
  console.log(`✅ 冷启动验收通过：${passed}/${checks.length} 项断言全部 PASS`)
  console.log(`   boot #1  seed=${seed1?.kind} · patch ${patchBytesBefore1} B → ${existsSync(PATCH) ? readFileSync(PATCH).length : 0} B · providers.${PROVIDER_ID}=${block1?.models ?? '?'} 个模型`)
  if (!SKIP_RESTART) console.log(`   boot #2  seed=present · providers.${PROVIDER_ID} 段未变 · 全文件 sha256 ${patch1?.slice(0, 16)}`)
  console.log(`   端口 ${PORT} 结束时${finalOwners.length === 0 ? '空闲' : `仍被 ${finalOwners.join(', ')} 占用`} · boot.log 里 ${seedCreatedCount} 次 create 记录`)
} else {
  console.log(`🔴 冷启动验收未通过：${failures} 项失败 / 共 ${checks.length} 项`)
}
console.log(`   本次运行 ${seconds(Date.now() - runStarted)} · 临时树 ${SCRATCH}`)
console.log(`   活体 home（${REAL_HOME}）未被本脚本写过任何东西 —— 网关凭证只被只读拷了一份副本进临时树`)

/* ── 16. 清理（进程树已收 → 端口已验 → 再删临时目录） ───────────────────── */
if (KEEP_PROFILE) {
  console.log(`   --keep-profile：保留临时树（下次可复用；删除：rmdir /s /q "${SCRATCH}"）`)
} else if (ok) {
  try {
    // 先摘 junction，再递归删（顺序与重建时同理）。
    if (existsSync(junction)) rmSync(junction, { force: true, recursive: false })
    rmSync(SCRATCH, { recursive: true, force: true })
    console.log(`   清理：已删除临时树（含凭证副本）${existsSync(SCRATCH) ? ' —— 但目录还在！' : ''}`)
  } catch (error) {
    console.log(`   ⚠ 清理临时树失败（不影响结论）：${error instanceof Error ? error.message : String(error)}`)
  }
} else {
  console.log(`   保留临时树便于排查（boot.log：${TRACE}）；删除：rmdir /s /q "${SCRATCH}"`)
}
console.log(line('='))
process.exit(ok ? 0 : 1)
