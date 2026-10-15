#!/usr/bin/env node
/**
 * dsh-pylon-workbuddy **真·从零**验收 —— 「别人在新电脑上装，能不能用」。
 *
 * ## 为什么必须有这一支，而 coldstart-verify 不能替代它
 *
 * `coldstart-verify.mjs` 的两条**前置条件**是「活体 `~/.dsh/wb2api` 里已经有网关二进制」
 * （它拿来做 `binaryPath`）与「`auths/` 里至少有一份凭证」（它只读拷一份副本进临时树）。
 * 也就是说，它证明的是「**已装好的人**重启 dsh 时插件行为正确」——`seed: created`
 * 是被它拷进去的那份凭证喂出来的。
 *
 * 发布到插件市场之后，绝大多数人是**新电脑、空目录、没有任何凭证**。
 * 那条路至今没有证据。本脚本就只证明那一件事。
 *
 * ## 「从零」的严格定义（本脚本强制的东西）
 *
 * ```
 * <scratch>/home          干净 DSH_HOME（独立，绝不与活体 ~/.dsh 重叠）
 * <scratch>/home/wb2api/  【空】—— 没有 bin/、没有 auths/、没有 config.json
 * <scratch>/gateway/      网关运行目录（同样空的）
 * <scratch>/profile/      临时 profile：只装本插件，bundles = base + llm-pi-ai + 本插件
 * ```
 *
 * 🔴 **活体 `~/.dsh/wb2api` 的任何东西都不被借用**：不拷二进制、不拷凭证、不读 config。
 *    本脚本对活体 home 只有两种接触：**启动前后各做一次只读快照**（用来证明自己没写它），
 *    以及一条**只读**的 HTTP 可达性探测。`refuseIfLiveContamination()` 在建立临时树之前
 *    就把这件事钉死。
 *
 * ## 五个断言（每一条都要能指着实测输出说话）
 *
 * | # | 问题 | 怎么验 |
 * |---|------|--------|
 * | 1 | 空目录下 `/wb2api-setup` 那条路能不能自动下载 + SHA256 校验通过 | 实例化**真的** `GatewayBinaryInstaller`（lib/，即发布产物），
 *        把 `installDir`/`runtimeDir` 显式指到临时树，跑 `ensure()`，再独立复算 sha256 比对 |
 * | 2 | 无凭据时插件是引导登录还是静默什么都不做 | 起真 DSH 进程，读 `<home>/.wb2api/boot.log` 的原始行 |
 * | 3 | 无凭据时网关 `/v1/models` 返回什么、插件会不会写一个 0 模型的 provider | 起**真的下载来的**网关进程打 `/v1/models`；再看 DSH 那一轮到底写了没写 provider |
 * | 4 | `/wb2api-login` 在无凭据时会不会给出明确指引 | 用**同一个**真 SetupRunner 编排到登录那一步，收集它交给用户的原文；
 *        并静态核对命令面（不真登录 —— 那需要真账号，也会在上游创建真 state） |
 * | 5 | 收尾干净：进程杀光、端口无残留 | 进程台账 `taskkill /F /T` + `netstat` 复检 |
 *
 * ## 用法
 *
 *   <node> tools/from-scratch-verify.mjs [--keep-scratch] [--skip-gateway] [--skip-net]
 *                                       [--capture] [--timeout 90] [--port 7869] [--help]
 *
 *   --keep-scratch   保留临时树便于排查（默认全绿时删掉）
 *   --skip-gateway   不真起网关进程（只做 DSH 那一轮 + 下载）
 *   --skip-net       跳过联网前的可达性探测（离线环境的预期形态）
 *   --capture        子进程 stdout/stderr 落 `<scratch>/fromscratch-<label>.log`
 *   --timeout <sec>  等 DSH seed 的预算（默认 90）
 *   --port <n>       网关回环端口（默认 7869；**刻意避开活体网关的 7863**）
 *
 * **退出码**：`0` 五个断言全过 · `1` 有断言 FAIL · `2` 参数错 / 环境不满足（隔离形状不对、端口被占、dsh 启动器不在）
 *
 * **写入**：只有 `<工作区>\_pylon-fromscratch\**`。活体 home 一个字节都不写。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/* ── 1. 参数 ─────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 || argv[index + 1] === undefined ? fallback : argv[index + 1]
}

const HELP = has('help') || argv.includes('-h')
const KEEP_SCRATCH = has('keep-scratch')
const SKIP_GATEWAY = has('skip-gateway')
const SKIP_NET = has('skip-net')
const CAPTURE = has('capture')
const FORCE_PORT = has('force-port')
const TIMEOUT_MS = Math.max(10, Number(opt('timeout', '90'))) * 1000
const PORT = Number(opt('port', '7869'))
const DSH_PROFILE_MODE = opt('dsh-profile', 'desktop')

if (HELP) {
  console.log('用法：node tools/from-scratch-verify.mjs [--keep-scratch] [--skip-gateway] [--skip-net]')
  console.log('       [--capture] [--timeout <秒>] [--port <端口>] [--help]')
  console.log('')
  console.log('  --keep-scratch  保留临时树（默认全绿时删掉）')
  console.log('  --skip-gateway  不真起网关进程')
  console.log('  --skip-net      跳过联网可达性探测')
  console.log(`  --timeout <s>   等 DSH seed 的预算（默认 ${TIMEOUT_MS / 1000}）`)
  console.log(`  --port <n>      网关回环端口（默认 ${PORT}，避开活体 7863）`)
  console.log('')
  console.log('退出码：0 五条断言全过 · 1 有 FAIL · 2 参数错或环境不满足')
  console.log('写入：只有 <工作区>\\_pylon-fromscratch\\**；活体 ~/.dsh 只读、不写。')
  process.exit(0)
}
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`拒绝运行：--port ${opt('port', '')} 不是合法端口。`)
  process.exit(2)
}

/* ── 2. 路径与隔离自检 ───────────────────────────────────────────────────── */
const PLUGIN_DIR = resolve(import.meta.dirname, '..')
const SCRATCH = resolve(PLUGIN_DIR, '..', '_pylon-fromscratch')
const HOME = join(SCRATCH, 'home')
const PROFILE_NAME = 'zz-fs'
const PROFILE = join(HOME, 'profiles', PROFILE_NAME)
const PATCH = join(PROFILE, 'cordis.patch.yml')
/** 插件的轨迹与墓碑：`<DSH_HOME>/.wb2api/`（**有点**，与网关工作目录不同一处）。 */
const OWN_DIR = join(HOME, '.wb2api')
const TRACE = join(OWN_DIR, 'boot.log')
const STATE_FILE = join(OWN_DIR, 'state.json')
/** 这一轮**必须为空**的那两个目录 —— 「从零」的物证。 */
const HOME_GATEWAY_DIR = join(HOME, 'wb2api')
const GATEWAY_RUN_DIR = join(SCRATCH, 'gateway')
/** 下载落点：完全在临时树内，绝不碰活体 `~/.dsh/wb2api/bin`。 */
const INSTALL_DIR = join(HOME_GATEWAY_DIR, 'bin')
const LEDGER = join(SCRATCH, 'fromscratch-pids.json')
const DSH_CMD = 'D:\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd'
const COMSPEC = process.env['ComSpec'] ?? 'cmd.exe'
const PLUGIN_PACKAGE = 'dsh-pylon-workbuddy'
/**
 * ★ 与包名**不是**同一个字符串（实测踩到的坑）：`cordis.patch.yml` 里 `- id:` 覆盖的是
 * **实例 id**（`src/index.ts` 的 `export const name`）。写成包名时**一条也匹配不上**，
 * 插件照旧用默认配置（端口 7863）而脚本看起来"跑了"。
 */
const PLUGIN_INSTANCE = 'pylon-workbuddy'
/** 数据面 namespace：**是 profile 条目 id**，不是插件自己的 `llm-workbuddy2api`。 */
const SETTINGS_NS = 'llm-pi-ai'
const PROVIDER_ID = 'workbuddy'

const REAL_HOME = resolve(homedir(), '.dsh')
function assertIsolation() {
  if (resolve(HOME) === REAL_HOME || REAL_HOME.startsWith(resolve(HOME) + sep)) {
    console.error(`拒绝运行：DSH_HOME(${HOME}) 与真实 home(${REAL_HOME}) 重叠。`)
    process.exit(2)
  }
  if (basename(HOME) !== 'home' || basename(SCRATCH) !== '_pylon-fromscratch') {
    console.error(`拒绝运行：临时 home 形状不对（${HOME}）—— 期望 <工作区>\\_pylon-fromscratch\\home。`)
    process.exit(2)
  }
  for (const path of [PROFILE, HOME_GATEWAY_DIR, GATEWAY_RUN_DIR, INSTALL_DIR]) {
    if (!resolve(path).startsWith(resolve(SCRATCH) + sep)) {
      console.error(`拒绝运行：${path} 不在 scratch 之内。`)
      process.exit(2)
    }
  }
}
assertIsolation()

/* ── 3. 报告 ────────────────────────────────────────────────────────────── */
/** 跨段落要传递的实测事实（断言之间互相引用时只有一处真相）。 */
const EVIDENCE = {
  /** 断言 1 开跑前二进制是否存在 —— 「从零的下载路径真的被走到过」全靠这一条。 */
  binaryExistedBeforeDownload: undefined,
  /** 断言 1 结束后是否存在。 */
  binaryExistedAfterDownload: undefined,
}
const checks = []
let failures = 0
function check(name, passed, evidence = '') {
  checks.push({ name, passed, evidence })
  if (!passed) failures += 1
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${evidence === '' ? '' : `  — ${evidence}`}`)
  return passed
}
const info = (message) => console.log(`      ${message}`)
const note = (message) => console.log(`  ★   ${message}`)
const line = (char = '-', width = 78) => char.repeat(width)
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
function redact(text) {
  return String(text)
    .replace(/(Bearer\s+)\S+/gi, '$1<redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<redacted-jwt>')
}
const fingerprint = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12)
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

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

/* ── 4. 进程台账 + 端口卫生（照抄 coldstart-verify 的实测结论） ──────────── */
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
    // 台账是便利设施，不该成为一次运行失败的原因
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
  // 拼 **Buffer**，不是 `${stdout}`：模板插值会先用 UTF-8 把 OEM 字节解坏。
  const bytes = Buffer.concat([run.stdout ?? Buffer.alloc(0), run.stderr ?? Buffer.alloc(0)])
  return { status: run.status, text: decodeOem(bytes).trim().replace(/\s+/g, ' ') }
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

/* ── 5. 活体 home 的**只读**快照（用来证明本脚本没写它） ─────────────────── */
const REAL_GATEWAY = join(REAL_HOME, 'wb2api')
const REAL_OWN = join(REAL_HOME, '.wb2api')
/**
 * 快照一个路径的「形状」：存在性 + 类型 + 大小 + mtime。
 *
 * 只读：`statSync` 不碰内容。目录只取自身，不递归 —— 递归会读凭证文件，而本脚本
 * 对活体凭证连读都不该做。
 */
function snapshotPath(path) {
  try {
    const stat = statSync(path)
    if (stat.isDirectory()) {
      let entries = []
      try {
        entries = readdirSync(path).sort()
      } catch {
        entries = ['<unreadable>']
      }
      return { exists: true, kind: 'dir', mtime: stat.mtimeMs, entries }
    }
    return { exists: true, kind: 'file', mtime: stat.mtimeMs, size: stat.size }
  } catch {
    return { exists: false }
  }
}
const LIVE_BEFORE = {
  gateway: snapshotPath(REAL_GATEWAY),
  own: snapshotPath(REAL_OWN),
}
function liveUnchanged() {
  const after = { gateway: snapshotPath(REAL_GATEWAY), own: snapshotPath(REAL_OWN) }
  const diffs = []
  for (const key of ['gateway', 'own']) {
    const before = LIVE_BEFORE[key]
    const now = after[key]
    if (before.exists !== now.exists) { diffs.push(`${key}: 存在性 ${before.exists} → ${now.exists}`); continue }
    if (!before.exists) continue
    if (before.kind !== now.kind) diffs.push(`${key}: 类型变了`)
    if (before.mtime !== now.mtime) diffs.push(`${key}: mtime 变了`)
    if (before.kind === 'dir' && JSON.stringify(before.entries) !== JSON.stringify(now.entries)) {
      diffs.push(`${key}: 条目从 [${before.entries.join(', ')}] 变成 [${now.entries.join(', ')}]`)
    }
    if (before.kind === 'file' && before.size !== now.size) diffs.push(`${key}: 大小 ${before.size} → ${now.size}`)
  }
  return diffs
}

/* ── 6. 探测：联网可达性 + 活体凭据（**只读**） ──────────────────────────── */
async function probeUrl(url, timeoutMs = 20000) {
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { accept: 'application/octet-stream, text/plain, */*' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { ok: response.ok, status: response.status, ms: Date.now() - started, bytes: (await response.arrayBuffer()).byteLength }
  } catch (error) {
    const cause = /** @type {{ cause?: { code?: string } }} */ (error)?.cause
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: `${error instanceof Error ? error.message : String(error)}${cause?.code === undefined ? '' : ` (${cause.code})`}`,
    }
  }
}

/* ── 7. patch 的结构化读法（与 coldstart-verify 同源，不引 YAML 依赖） ──── */
const indentOf = (row) => row.length - row.trimStart().length
const isBlank = (row) => row.trim() === '' || row.trimStart().startsWith('#')
function blockEnd(rows, keyIndex, keyIndent) {
  for (let i = keyIndex + 1; i < rows.length; i += 1) {
    if (isBlank(rows[i])) continue
    if (indentOf(rows[i]) <= keyIndent) return i
  }
  return rows.length
}
function readProviderBlock(text, providerId) {
  const rows = text.split(/\r?\n/)
  const result = { topLevelEntries: rows.filter((row) => /^- /.test(row)).length, found: false, models: 0, baseUrl: undefined, blockStart: undefined }
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

/* ── 8. DSH 进程：boot.log 轮询（断前缀，不断行数） ─────────────────────── */
function traceLines() {
  if (!existsSync(TRACE)) return []
  return readFileSync(TRACE, 'utf8').split(/\r?\n/).filter((row) => row.trim() !== '')
}
const SEED_RE = /seed:\s*([a-z-]+)/
/**
 * 一条 `seed:` 行是不是**结局**。
 * ★ `seed: start（…）` 也匹配 `SEED_RE`；把它当结局会把一次真的 created 报成 FAIL。
 */
const SEED_OUTCOME_RE = /seed:\s*(?!start\b|已排入|跳过|threw\b)[a-z-]+/
function parseSeed(row) {
  return {
    kind: SEED_RE.exec(row)?.[1] ?? 'unknown',
    ns: /\bns=(\S+)/.exec(row)?.[1],
    note: /（(.+?)）/.exec(row)?.[1],
    raw: row,
  }
}
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
        `${label} 在写出 seed 之前就退出了（exitCode=${child.exitCode} signal=${child.signalCode}）—— boot.log 新增 ${fresh.length} 行：\n`
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

async function startDsh(label) {
  const env = { ...process.env, DSH_HOME: HOME, DSH_NODE: process.execPath }
  if (DSH_PROFILE_MODE === 'unset') delete env['DSH_PROFILE']
  else env['DSH_PROFILE'] = DSH_PROFILE_MODE
  // 总是收管道（见 collectChildOutput 的注释）：用户文案走 stdout，不看它就等于没验。
  const stdio = ['ignore', 'pipe', 'pipe']
  // Windows 上 `.cmd` 不能被 spawn 直接执行，必须走 cmd.exe；且**必须**带
  // `windowsVerbatimArguments`，否则 libuv 把内层引号转义成 `\"`，cmd.exe 把它读成
  // 字面反斜杠并回一句 "syntax is incorrect"，进程 0.3 秒退出（实测结论，照抄）。
  const inner = `"${DSH_CMD}" --profile ${PROFILE_NAME} --no-open --port 0`
  const child = spawn(COMSPEC, ['/d', '/s', '/c', `"${inner}"`], {
    cwd: SCRATCH,
    env,
    stdio,
    windowsHide: true,
    windowsVerbatimArguments: true,
  })
  collectChildOutput(child, label)
  trackChild(child, label)
  return child
}

/* ── 9. 下载器：直接用**发布产物** lib/，不重写一份逻辑 ─────────────────── */
async function importBinaryModule() {
  const entry = join(PLUGIN_DIR, 'lib', 'gateway-binary.js')
  if (!existsSync(entry)) return { module: undefined, entry }
  return { module: await import(pathToFileURL(entry).href), entry }
}

/**
 * 子进程输出通道。
 *
 * ★ 这里踩过一个坑：第一版把 DSH 的 stdio 设成 `'ignore'`，于是"用户到底看到什么"
 * 这一半完全没有证据 —— 插件把用户文案发到 `console`（stdout），**不是** boot.log
 * （那一支刻意只写轨迹锚点）。所以本脚本现在**总是**把子进程输出收到管道里：
 * 内容不落盘（避免把可能含 token 的日志写进工作区），只在内存里过滤 + 提交前过 {@link redact}。
 */
const childOutput = []
function collectChildOutput(child, label) {
  const keep = (stream, tag) => {
    stream?.on('data', (chunk) => {
      for (const row of String(chunk).split(/\r?\n/)) {
        if (row.trim() !== '') childOutput.push({ label, tag, row: row.trimEnd() })
      }
    })
  }
  keep(child.stdout, 'out')
  keep(child.stderr, 'err')
}
/** 子进程输出里含任一关键字的行（原始，未 redact —— 调用方负责脱敏后再打印）。 */
function outputMatching(re) {
  return childOutput.filter((entry) => re.test(entry.row)).map((entry) => `${entry.label}/${entry.tag}  ${entry.row}`)
}

/* ══════════════════════════════════════════════════════════════════════════
 * 正式流程
 * ══════════════════════════════════════════════════════════════════════════ */
const runStarted = Date.now()
console.log(line('='))
console.log(`dsh-pylon-workbuddy 真·从零验收（新电脑模拟）  ${new Date().toISOString()}`)
console.log(line('='))
info(`node            ${process.version}`)
info(`插件目录        ${PLUGIN_DIR}`)
info(`临时 DSH_HOME   ${HOME}`)
info(`活体 home       ${REAL_HOME}`)
info(`dsh 启动器      ${DSH_CMD}${existsSync(DSH_CMD) ? '' : '  ← 不存在！'}`)
console.log(line())

if (!existsSync(DSH_CMD)) {
  console.log(`🔴 dsh 启动器不存在：${DSH_CMD}`)
  console.log('结论：未开始即中止。')
  process.exit(2)
}

/* ── 断言 0：从零的形状 ─────────────────────────────────────────────────── */
console.log('[0/5] 从零形状：建立干净的临时树')
reapLedger()
// 先摘 junction 再递归删：递归删一条含 junction 的目录正是会吃掉源码树的操作。
const junction = join(PROFILE, 'node_modules', PLUGIN_PACKAGE)
if (existsSync(junction)) rmSync(junction, { force: true, recursive: false })
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })
mkdirSync(HOME_GATEWAY_DIR, { recursive: true })
mkdirSync(GATEWAY_RUN_DIR, { recursive: true })
mkdirSync(OWN_DIR, { recursive: true })

const homeGatewayEntries = readdirSync(HOME_GATEWAY_DIR)
const runDirEntries = readdirSync(GATEWAY_RUN_DIR)
check(
  '临时 wb2api 目录是空的（无 bin/、无 auths/、无 config.json）',
  homeGatewayEntries.length === 0 && runDirEntries.length === 0,
  `${homeGatewayEntries.length} 个条目 + 运行目录 ${runDirEntries.length} 个条目`,
)
check(
  '活体 ~/.dsh/wb2api 事先存在与否已被记录（本脚本不读它的内容）',
  true,
  LIVE_BEFORE.gateway.exists
    ? `事先存在：${LIVE_BEFORE.gateway.entries.join(', ') || '(空)'} —— 本轮**不借用**其中任何一项`
    : '事先不存在（这台机器上本来就没有活体网关）',
)
note(LIVE_BEFORE.gateway.exists
  ? '活体网关与凭证都在，但本脚本只做只读快照 + 只读 HTTP 探测；下载落点被显式改到临时树'
  : '这台机器上本来就没有活体网关 ⇒ 隔离结论更强')

// 端口卫生：端口不干净会伪装成插件失败。
if (!(await portFree(PORT))) {
  const owners = portOwners(PORT)
  console.log(`🔴 端口 ${PORT} 已被占用：PID ${owners.join(', ') || '(netstat 没报出持有者)'}`)
  if (!FORCE_PORT) {
    console.log('结论：未开始即中止（端口不干净会伪装成插件失败；--force-port 可让本脚本清掉它）。')
    process.exit(2)
  }
  for (const owner of owners) {
    const result = killTree(owner)
    info(`--force-port：taskkill /PID ${owner} /F /T → exit=${result.status}`)
  }
  await sleep(750)
  if (!(await portFree(PORT))) {
    console.log(`🔴 --force-port 之后端口 ${PORT} 仍被占用，中止。`)
    process.exit(2)
  }
}
info(`端口 ${PORT} 空闲`)

/* ── 临时 profile：只装本插件 ───────────────────────────────────────────── */
writeFileSync(join(PROFILE, 'cordis.yml'), '# from-scratch profile — an empty entry list.\n[]\n', 'utf8')
// ★ bundles 里**只写实际存在的包**。实测：`@deepseek-ai/llm-pi-ai` **不存在**
//   （真名是 `@deepseek-ai/dsh-llm-pi-ai`），写进 bundles 会让 dsh 打一条
//   `skipping profile bundle ... cannot resolve` 的警告；而 `llm-pi-ai` 这个**条目**
//   本来就由 `@deepseek-ai/dsh-base` 提供 —— 组合结果里有它，name 也正确。
//   多写一条不但没用，还会让"这条警告是不是问题"变成每次都要重新判断的噪音。
writeFileSync(
  join(PROFILE, 'package.json'),
  `${JSON.stringify({
    name: `dsh-profile-${PROFILE_NAME}`,
    private: true,
    dependencies: { [PLUGIN_PACKAGE]: `link:${PLUGIN_DIR.replaceAll('\\', '/')}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', PLUGIN_PACKAGE] } },
  }, null, 2)}\n`,
  'utf8',
)
// ★ 这里**刻意不写** `- id: ${SETTINGS_NS} / name: "@deepseek-ai/${SETTINGS_NS}"` 这一行。
//
//   实测（`dsh --profile <p> --dump-config` 的 stderr，逐字）：
//     dsh: [<profile>\\cordis.patch.yml] patch: name mismatch for "llm-pi-ai"
//          (expected "@deepseek-ai/dsh-llm-pi-ai", got "@deepseek-ai/llm-pi-ai"), skipping
//   包名是 **@deepseek-ai/dsh-llm-pi-ai**；`llm-pi-ai` 这个条目本来就由
//   `@deepseek-ai/dsh-base` 提供（组合结果里 `- id: llm-pi-ai` 照样在，name 正确）。
//   所以那一行既解析不到（还会打一条 bundle 解析失败的警告），又会让 profile 看起来
//   "已经处理过 llm-pi-ai" —— 而 `providers: {}` 那一句会真的落地、把 base 的
//   providers 清成空。本脚本第一版就是带着这一行跑的，于是设置写入在**空目录**下
//   抛了 `resolves no models`，把「零凭据会给新用户写一个 0 模型 provider」
//   这条真实路径**盖住了**（报出来的是一个更好看但不对的失败）。
//
//   现在这条 patch 只留**实例配置覆盖**，与真机形态一致。
const binaryPathInScratch = join(INSTALL_DIR, 'wb2a-server.exe')
writeFileSync(
  PATCH,
  [
    '# from-scratch profile patch (user layer) —— 只覆盖插件实例配置',
    '# （数据面 llm-pi-ai 由 bundles 里的 @deepseek-ai/dsh-base 提供，不要在这里重写）',
    '# ★ 下面这些覆盖是**测试装置**：把「插件会写哪里」全部收进临时树，',
    '#   活体 ~/.dsh 因此连一次写入都不会发生。它们不是新电脑上的默认值 ——',
    '#   默认值（binaryPath/workingDir/writeBackupDir 皆空）会把目标解到 homedir()，见结论里那段。',
    `- id: ${PLUGIN_INSTANCE}`,
    '  config:',
    `    binaryPath: ${JSON.stringify(binaryPathInScratch.replaceAll('\\', '/'))}`,
    `    workingDir: ${JSON.stringify(GATEWAY_RUN_DIR.replaceAll('\\', '/'))}`,
    `    listenPort: ${PORT}`,
    `    baseURL: http://127.0.0.1:${PORT}/v1`,
    '    autoStart: true',
    '# 显式钉住「不自动下载」：新电脑上默认就是这个行为（DEFAULT_CONFIG.autoDownloadBinary=false），',
    '# 钉住它，删掉 profile 后结论不会变。',
    '    autoDownloadBinary: false',
    `    providerNamespace: ${SETTINGS_NS}`,
    `    writeBackupDir: ${JSON.stringify(join(SCRATCH, 'write-backups').replaceAll('\\', '/'))}`,
    '',
  ].join('\n'),
  'utf8',
)
symlinkSync(PLUGIN_DIR, junction, 'junction')
writeFileSync(TRACE, '', 'utf8')
info(`临时 profile 已建：bundles = @deepseek-ai/dsh-base + ${PLUGIN_PACKAGE}（llm-pi-ai 条目由 dsh-base 提供）· 只 junction 本插件`)
info('覆盖：binaryPath/workingDir/writeBackupDir 全在临时树内（隔离装置，不是新电脑默认值）')
console.log(line())

/* ── 断言 1：空目录下能不能自动下载 + SHA256 校验 ───────────────────────── */
console.log('[1/5] 网关二进制：空目录下的下载 + SHA256 校验')
let downloaded = { ran: false }
EVIDENCE.binaryExistedBeforeDownload = existsSync(binaryPathInScratch)
check(
  '下载路径起点的「从零」状态被实测确认：目标二进制本来不存在',
  EVIDENCE.binaryExistedBeforeDownload === false,
  EVIDENCE.binaryExistedBeforeDownload ? `**已存在**（${binaryPathInScratch}）—— 这一轮的下载不是从零` : `${binaryPathInScratch} 不存在`,
)
const { module: binaryModule, entry: binaryEntry } = await importBinaryModule()
if (binaryModule === undefined) {
  check('能从发布产物 lib/gateway-binary.js 取到下载器', false, `${binaryEntry} 不存在（先跑 npm run build）`)
} else {
  const repo = binaryModule.DEFAULT_RELEASE_REPO ?? 'rumilhz/dsh-pylon-workbuddy'
  const target = binaryModule.currentTarget(process.platform, process.arch)
  const asset = target === undefined ? '(不支持的平台)' : binaryModule.assetName(target)
  const clientUrl = binaryModule.assetUrl(repo, target ?? { os: 'windows', arch: 'amd64' })
  const checksumsUrl = binaryModule.checksumsUrl(repo)
  info(`发布仓库        ${repo}`)
  info(`本平台目标      ${asset}`)
  info(`产物地址        ${clientUrl}`)

  // 校验链的三段（本脚本自己独立复算，不听安装器自报）：发布清单 → 归档 → 落盘产物。
  let expectedFromManifest
  let archiveHash
  let archiveHashOk
  if (!SKIP_NET) {
    const probe = await probeUrl(checksumsUrl)
    if (probe.ok) {
      const raw = await fetch(checksumsUrl, { signal: AbortSignal.timeout(20000) })
      const table = binaryModule.parseChecksums(new TextDecoder().decode(new Uint8Array(await raw.arrayBuffer())))
      expectedFromManifest = table.get(asset)
      check(
        '联网可达：release 的 SHA256SUMS.txt 能取到，且含本平台条目',
        expectedFromManifest !== undefined,
        `HTTP ${probe.status} · ${probe.bytes} B · 清单 ${table.size} 条 · 本平台 ${expectedFromManifest === undefined ? '**不在**' : `在（${expectedFromManifest.slice(0, 16)}…）`}（${probe.ms}ms）`,
      )
    } else {
      check(
        '联网可达：release 的 SHA256SUMS.txt 能取到',
        false,
        `HTTP ${probe.status || '(连接失败)'}${probe.error === undefined ? '' : ` · ${probe.error}`} · ${probe.ms}ms —— 国内网络风险点，插件会据此拒绝安装`,
      )
    }
  } else {
    info('--skip-net：跳过可达性探测')
  }

  // 真下载：**显式**把 installDir / runtimeDir 指进临时树（这是本脚本的隔离装置；
  // 新电脑上的默认值是 homedir()/.dsh/wb2api，见结论）。
  const installer = new binaryModule.GatewayBinaryInstaller({
    installDir: INSTALL_DIR,
    runtimeDir: GATEWAY_RUN_DIR,
    listenPort: PORT,
    logger: { info: (m) => info(`[installer] ${m}`), warn: (m) => info(`[installer:warn] ${m}`), error: (m) => info(`[installer:error] ${m}`) },
  })
  const startedDownload = Date.now()
  try {
    const result = await installer.ensure()
    const size = existsSync(result.path) ? statSync(result.path).size : 0
    // 把「这一轮之前到底有没有二进制」记录下来：断言 1 之后它必然存在，
    // 而 setup 那一段的「已存在，未重新下载」只有在这个前提下才是幂等而不是掩盖。
    const existedBefore = EVIDENCE.binaryExistedBeforeDownload
    EVIDENCE.binaryExistedAfterDownload = existsSync(result.path)
    info(`下载前后：before=${String(existedBefore)} → after=${String(EVIDENCE.binaryExistedAfterDownload)}`)
    // 自己再下一遍**归档**并复算：这是"清单里那个 hash 是不是真能对上归档"的独立证据，
    // 也是"落盘产物来自那份归档"的独立证据（而不是相信安装器自己报的数字）。
    if (!SKIP_NET) {
      const archiveProbe = await probeUrl(clientUrl)
      if (archiveProbe.ok) {
        const response = await fetch(clientUrl, { signal: AbortSignal.timeout(60000) })
        const bytes = new Uint8Array(await response.arrayBuffer())
        archiveHash = binaryModule.sha256(bytes)
        archiveHashOk = expectedFromManifest === undefined ? undefined : archiveHash === expectedFromManifest
      }
    }
    const extracted = existsSync(result.path) ? binaryModule.sha256(readFileSync(result.path)) : ''
    downloaded = { ran: true, result, size, extracted, archiveHash, archiveHashOk, ms: Date.now() - startedDownload }
    check(
      '空目录下 ensure() 真的下载并安装成功（downloaded=true）',
      result.downloaded === true && existsSync(result.path) && size > 0,
      `asset=${result.asset} · ${size} B · ${seconds(downloaded.ms)} · sha256 ${String(result.sha256 ?? '').slice(0, 12)}…`,
    )
    // ★ 比对的对象必须同类：`result.sha256` 是**归档（.zip）**的 hash，不是解压后 .exe 的
    //   hash；拿 .exe 的 hash 去比它永远不等（本脚本第一版就是这么误报的，白写了一轮）。
    //   三方独立证据：① 清单里那一条；② 本脚本自己下的同一份归档；③ 安装器自报。
    const chainOk = archiveHashOk === true
      && (result.sha256 === undefined || result.sha256 === archiveHash)
      && extracted !== '' && extracted !== archiveHash
    check(
      '校验链独立复核：SHA256SUMS.txt 条目 == 本脚本自下的归档 == 安装器自报（且落盘产物是解压后的另一份字节）',
      chainOk,
      archiveHashOk === undefined
        ? `--skip-net：只核对了安装器自报 ${String(result.sha256 ?? '').slice(0, 16)}… 与落盘产物 ${extracted.slice(0, 16)}…（两者本就该不同：一个是 zip、一个是 exe）`
        : `清单/自下归档 ${String(archiveHash).slice(0, 16)}… · 安装器自报 ${String(result.sha256 ?? '(无)').slice(0, 16)}… · 解压后 exe ${extracted.slice(0, 16)}…（${size} B）· 归档三方一致=${archiveHashOk && (result.sha256 ?? archiveHash) === archiveHash}`,
    )
    check(
      '运行目录被一并准备（config.json + auths/ + data/）',
      existsSync(result.configPath) && existsSync(join(GATEWAY_RUN_DIR, 'auths')),
      `${result.configPath}${result.configCreated ? '（本次新建）' : '（已存在）'} · auths/ ${existsSync(join(GATEWAY_RUN_DIR, 'auths')) ? '在' : '缺'}`,
    )
    check(
      '下载落点确实在临时树内，没有碰活体 ~/.dsh/wb2api/bin',
      resolve(result.path).toLowerCase().startsWith(resolve(SCRATCH).toLowerCase() + sep),
      result.path,
    )
    info(`安装耗时        ${seconds(downloaded.ms)}`)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    downloaded = { ran: true, error: text, ms: Date.now() - startedDownload }
    check('空目录下 ensure() 真的下载并安装成功', false, `${seconds(downloaded.ms)} 后失败`)
    console.log('      ── 用户会看到的原文案（begin） ──')
    for (const row of text.split('\n')) console.log(`      ${redact(row)}`)
    console.log('      ── 用户会看到的原文案（end） ──')
  }
}
console.log(line())

/* ── 断言 2：真 DSH 进程，无凭据时到底发生什么 ──────────────────────────── */
console.log('[2/5] 真 DSH 进程（干净 home · 空 wb2api · 零凭据）')
const bootStarted = Date.now()
const child = await startDsh('boot')
let seed
let seedThrew
{
  info(`已启动 cmd.exe PID ${child.pid}（taskkill /F /T 收整棵树）`)
  const seen = 0
  try {
    const waited = await awaitSeed(child, seen, '从零启动')
    seed = waited.seed
    info(`boot.log 新增 ${waited.fresh.length} 行（${seconds(waited.elapsed)} 后出现 seed 结局行）：`)
    for (const row of waited.fresh) info(`  ${redact(row)}`)
  } catch (error) {
    seedThrew = error instanceof Error ? error.message : String(error)
    check('插件在干净 home 里写出了 seed 结局行', false, seedThrew.split('\n').slice(0, 3).join(' / '))
  }
  const all = traceLines()
  if (seed === undefined && all.length > 0 && seedThrew === undefined) {
    info('boot.log 全部行：')
    for (const row of all) info(`  ${redact(row)}`)
  }
  console.log(`      冷启动用时 ${seconds(Date.now() - bootStarted)}`)
}

const gatewayLines = traceLines().filter((row) => /^\[workbuddy2api\]|gateway:|seed:|directory:/.test(row.replace(/^\S+\s+\S+\s+/, '')))
const patchAfterBoot = existsSync(PATCH) ? readFileSync(PATCH, 'utf8') : ''

const providerAfterBoot = readProviderBlock(patchAfterBoot, PROVIDER_ID)

if (seed !== undefined) {
  check(
    '无凭据时的 seed 结局是「明确失败」而不是静默什么都不做',
    seed.kind === 'failed',
    `kind=${seed.kind}${seed.note === undefined ? '' : ` · ${seed.note.slice(0, 120)}`}`,
  )
}
// ★ 「新用户第一眼看到什么」= 插件的**用户文案**（发往 stdout / host 日志）+ 轨迹。
//   boot.log 的定位是**轨迹锚点**（谁在什么时候走到哪一步），不是给用户看的文案；
//   所以下面两个通道各自有多少命中都打印出来，免得把「轨迹里没有引导语」误读成
//   「用户没有引导语」。
//
//   ★ 这一条**曾经是观察项**（当时的理由：正确答案取决于产品意图 —— 「零凭据时必须提示
//   /wb2api-setup」是不是硬要求）。**2026-10-15 产品侧已拍板：是硬要求**（发布到插件市场
//   之后绝大多数人是新电脑、空目录、零凭证），所以它现在是 PASS/FAIL：
//   判据 = **boot.log 里至少有一条指向前一步命令的指引**（那一支能活过日志被截断，
//   是排障时唯一还在的证据）。子进程输出（用户当屏看到的那一份）同时打印，供人核对。
const guidanceRe = /wb2api-login|wb2api-setup|没有可用账号|可用账号为 0|未找到网关可执行文件|\/wb2api-start/
const guidanceHits = outputMatching(guidanceRe)
const traceGuidance = traceLines().filter((row) => guidanceRe.test(row))
console.log(`  ○  无凭据时新用户看到的引导 —— 子进程输出命中 ${guidanceHits.length} 条 · boot.log 命中 ${traceGuidance.length} 条`)
if (guidanceHits.length > 0) {
  console.log('      ── 用户在 dsh 控制台会看到的引导（stdout/stderr 原文） ──')
  for (const row of guidanceHits.slice(0, 12)) console.log(`      ${redact(row)}`)
  console.log('      ── 引导结束 ──')
} else {
  note('子进程输出里**没有**任何指向 /wb2api-setup 或 /wb2api-login 的行 —— 新用户在这一轮看不到「下一步该敲什么命令」')
}
if (traceGuidance.length > 0) {
  console.log('      ── boot.log 里的引导行（轨迹通道） ──')
  for (const row of traceGuidance.slice(0, 12)) console.log(`      ${redact(row)}`)
  console.log('      ── 引导结束 ──')
}
check(
  '零凭据启动时 boot.log 里能搜到明确的下一步指引（照 /wb2api-setup → /wb2api-login 可走）',
  traceGuidance.length > 0,
  traceGuidance.length > 0
    ? `${traceGuidance.length} 条 · 例：${redact(traceGuidance[0]).slice(0, 220)}`
    : 'boot.log 里 0 条 —— 新用户在这一轮看不到「下一步该敲什么命令」（这正是 2026-10-15 断点 1 的判据）',
)
// 第一轮（零凭据 + 无二进制）用户实际看到的报错原文，原样留档 —— 这是最直接的答案。
const firstBootText = childOutput.filter((entry) => entry.label === 'boot').map((entry) => entry.row)
if (firstBootText.length > 0) {
  console.log('      ── 第一轮（零凭据、无二进制）子进程输出全文 ──')
  for (const row of firstBootText.slice(0, 24)) console.log(`      ${redact(row)}`)
  console.log('      ── 全文结束 ──')
}
check(
  '新用户这一刻看到的 provider 状态（这一条只报事实，不判对错）',
  true,
  providerAfterBoot.found
    ? `providers.${PROVIDER_ID} 已被写入，${providerAfterBoot.models} 个模型 ← 值得注意`
    : `providers.${PROVIDER_ID} 未被写入（patch 顶层条目 ${providerAfterBoot.topLevelEntries}）`,
)

// 网关子进程崩溃/未找到时，插件报的文案是什么 —— 这是新用户第一眼看到的报错。
const binaryMissingRe = /未找到网关可执行文件|binaryPath|已尝试/
const gatewayFailureLine = traceLines().find((row) => binaryMissingRe.test(row))
if (gatewayFailureLine !== undefined) {
  info(`网关未找到时的轨迹行：${redact(gatewayFailureLine).slice(0, 400)}`)
}
console.log(line())

/* ── 断言 3：这一轮里由 DSH 自己拉起的网关，零凭据时 /v1/models 返回什么 ────
 *
 * ★ 刻意**不**另起一个网关进程：DSH 已经按 `autoStart` 拉起了一个（受它托管），
 *   再起一个会抢同一个端口（EADDRINUSE），把「端口冲突」伪装成「网关起不来」——
 *   本脚本第一版就是这么误报的。直接问已起来的那个。
 *
 * 这一轮二进制**不在位**（断言 1 的下载在它之后才发生），因此网关大概率根本没起来，
 * 于是这一段最常见的结局是「端口上没有监听者」。那本身是一条有效结论（新用户
 * 第一轮什么都看不到），但**不能**用它回答「0 模型 provider」那个问题 —— 那要靠 3b。
 */
console.log('[3/5] 零凭据下网关的行为（问的是 DSH 自己拉起的那个进程）')
let modelsBody
let healthBody
let firstBootGatewayUp = false
if (SKIP_GATEWAY) {
  info('--skip-gateway：跳过')
} else {
  let owners = portOwners(PORT)
  const deadline = Date.now() + 25000
  while (owners.length === 0 && Date.now() < deadline) {
    await sleep(500)
    owners = portOwners(PORT)
  }
  if (owners.length === 0) {
    firstBootGatewayUp = false
    info(`端口 ${PORT} 上没有监听者 —— 第一轮二进制还没下载，autoStart 起不来（预期形态）`)
    check(
      '第一轮（二进制不在位）如实表现为「网关起不来」而不是假装成功',
      true,
      '端口无监听 · boot.log 里那条 autoStart 失败行见上',
    )
  } else {
    firstBootGatewayUp = true
    check('第一轮端口上有监听者', true, `PID ${owners.join(', ')} 监听 ${PORT}`)
    healthBody = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json()).catch(() => undefined)
    check(
      '零凭据下 /healthz 如实报 healthy=0（而不是假装正常）',
      healthBody !== undefined && healthBody.healthy === 0,
      `healthz: ${JSON.stringify(healthBody)}`,
    )
  }
}
console.log(line())

// 停掉 DSH。★ 受管网关是它的**子进程**：`taskkill /F /T` 应该连它一起收，但端口释放
// 有延迟 —— 残留一个监听者会让后面的启动以 EADDRINUSE 假失败。
let dshPortOwners = []
{
  const pid = child.pid
  const result = killTree(pid)
  console.log(`      停 DSH：taskkill /PID ${pid} /F /T → exit=${result.status}`)
  untrackChild(pid)
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    dshPortOwners = portOwners(PORT)
    if (dshPortOwners.length === 0 && (await portFree(PORT))) break
    await sleep(250)
  }
  dshPortOwners = portOwners(PORT)
  if (dshPortOwners.length > 0 && firstBootGatewayUp) {
    // 这些是**本脚本这一轮**启动的 DSH 留下的受管网关（不是外来进程）——直接补刀并说明。
    console.log(`      DSH 树收掉后端口 ${PORT} 仍被 PID ${dshPortOwners.join(', ')} 占着（受管网关的退出有延迟）——补刀`)
    for (const owner of dshPortOwners) {
      const extra = killTree(owner)
      console.log(`         taskkill /PID ${owner} /F /T → exit=${extra.status}`)
    }
    const deadline2 = Date.now() + 10000
    while (Date.now() < deadline2) {
      if (await portFree(PORT)) break
      await sleep(250)
    }
  }
  dshPortOwners = portOwners(PORT)
  check(
    `停掉 DSH 后端口 ${PORT} 已释放（受管网关随之退出）`,
    dshPortOwners.length === 0,
    dshPortOwners.length === 0 ? '空闲' : `仍被 PID ${dshPortOwners.join(', ')} 占用`,
  )
}

/* ── 断言 3b（关键）：第二轮启动 —— 二进制已在位、仍然零凭据 ──────────────
 *
 * 这是新电脑上**真正**会发生的第二轮：用户（或他点的按钮）跑过一次 /wb2api-setup，
 * 二进制下来了，但**还没登录**。此时：
 *   ① 网关这次能被 autoStart 拉起来（二进制在位）；
 *   ② 它空目录的回答是 200 + `{"data":[]}`；
 *   ③ ⇒ 插件会不会把这条**空目录**写成一个 0 模型的 provider？
 *
 * 上面那一轮（二进制不在位）会因为 `/v1/models` 在网关就绪前就失败而大概率落进
 * 「连续拉取都失败 ⇒ seed: failed」——**看起来很正确**，但它掩盖了这条路径。
 * 所以这一轮是必须的：断言 3 已经证明网关会安静地返回空目录。
 */
console.log('[3/5·补] 第二轮：二进制已在位、仍然零凭据（新电脑的真实第二轮）')
let secondProvider = { found: false, models: 0, topLevelEntries: 0 }
let secondSeed
if (SKIP_GATEWAY) {
  info('--skip-gateway：跳过')
} else if (downloaded.ran !== true || downloaded.result === undefined) {
  info('二进制没下来 ⇒ 这一轮无法进行（如实记下，不当成功）')
  check('二进制在位后重跑一次 DSH，观察空目录下 provider 的去向', false, '没有二进制可自动启动（见断言 1）')
} else {
  const seen = traceLines().length
  const child2 = await startDsh('boot2')
  info(`已启动 cmd.exe PID ${child2.pid}`)
  try {
    const waited = await awaitSeed(child2, seen, '第二轮启动')
    secondSeed = waited.seed
    info(`boot.log 新增 ${waited.fresh.length} 行（${seconds(waited.elapsed)}）：`)
    for (const row of waited.fresh) info(`  ${redact(row)}`)
  } catch (error) {
    check('第二轮启动写出了 seed 结局行', false, String(error instanceof Error ? error.message : error).split('\n').slice(0, 3).join(' / '))
  }
  const patchText2 = existsSync(PATCH) ? readFileSync(PATCH, 'utf8') : ''
  secondProvider = readProviderBlock(patchText2, PROVIDER_ID)
  if (secondSeed !== undefined) {
    check(
      '第二轮的 seed 结局已被实测（这一条只报事实）',
      true,
      `kind=${secondSeed.kind}${secondSeed.note === undefined ? '' : ` · ${secondSeed.note.slice(0, 100)}`}`,
    )
  }
  // 第二轮才问得到 /v1/models：这一轮网关是真的起来了（二进制在位）。
  let owners2 = portOwners(PORT)
  const deadlineModels = Date.now() + 20000
  while (owners2.length === 0 && Date.now() < deadlineModels) {
    await sleep(400)
    owners2 = portOwners(PORT)
  }
  if (owners2.length > 0) {
    healthBody = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json()).catch(() => undefined)
    check(
      '零凭据下 /healthz 如实报 healthy=0（而不是假装正常）',
      healthBody !== undefined && healthBody.healthy === 0,
      `healthz: ${JSON.stringify(healthBody)}`,
    )
    let apiKey = ''
    try {
      apiKey = JSON.parse(readFileSync(join(GATEWAY_RUN_DIR, 'config.json'), 'utf8')).api_key ?? ''
    } catch { /* 读不到就裸打，顺便看鉴权是不是真的开着 */ }
    const response = await fetch(`http://127.0.0.1:${PORT}/v1/models`, {
      headers: apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    }).catch(() => ({ status: 0, text: async () => '(请求失败)' }))
    const body = await response.text().catch(() => '')
    modelsBody = { status: response.status, body }
    const parsed = (() => { try { return JSON.parse(body) } catch { return undefined } })()
    const count = Array.isArray(parsed?.data) ? parsed.data.length : undefined
    check(
      '零凭据下 /v1/models 返回 HTTP 200 且 data 为空数组（不是报错）',
      response.status === 200 && count === 0,
      `HTTP ${response.status} · ${body.slice(0, 160)}`,
    )
    note(count === 0
      ? '⇒ 网关对「没有账号」的回答是 200 + 空目录，**不是错误**。这正是下面那条断点的入口。'
      : `⇒ data 长度 ${String(count)}（与本脚本预期不同，已如实记下）`)
  } else {
    info(`第二轮端口 ${PORT} 上仍无监听者 —— 网关这次也没起来（如实记下）`)
  }
  // ★ 这一条就是任务里点名要问的：「插件会不会写一个 0 模型的 provider 进去」。
  const wroteZeroModelProvider = secondProvider.found && secondProvider.models === 0
  const directoryLine = traceLines().filter((row) => row.includes('directory:')).pop()
  check(
    '零凭据下没有把空目录写成 0 模型的 provider（否则新用户会看到一个选了没用的供应商）',
    !wroteZeroModelProvider,
    wroteZeroModelProvider
      ? `**断点**：providers.${PROVIDER_ID} 已被写入且 0 个模型 —— seed=${secondSeed?.kind ?? '?'} · ${redact(directoryLine ?? '(无 directory 行)').slice(0, 120)}`
      : secondProvider.found
        ? `provider 已写入，${secondProvider.models} 个模型（不是 0）`
        : `未写入（patch 顶层条目 ${secondProvider.topLevelEntries}）`,
  )
  const pid = child2.pid
  const result = killTree(pid)
  console.log(`      停第二轮：taskkill /PID ${pid} /F /T → exit=${result.status}`)
  untrackChild(pid)
  const deadline3 = Date.now() + 15000
  while (Date.now() < deadline3) {
    if ((await portFree(PORT)) && portOwners(PORT).length === 0) break
    await sleep(250)
  }
  for (const owner of portOwners(PORT)) {
    console.log(`      端口 ${PORT} 仍被 PID ${owner} 占着 —— 补刀`)
    killTree(owner)
  }

  /* ── 第三轮（诊断）：网关**已经热着**（不复用上一轮，而是这一轮之前先起一个） ──
   *
   * 为什么单独来一轮：第二轮里 `/v1/models` 的**第一次**尝试是 `FAILED — fetch failed`
   * （网关刚被 autoStart 拉起，还没监听），1.5s 后重试才拿到 0 个模型。这一轮把
   * 「首拉就成功」与「首拉失败、重试成功」两条路径分开，回答的正是：
   *   **插件在零凭据下没能写出 provider，是因为「没有模型」，还是因为「重试」本身有问题？**
   */
  const seen3 = traceLines().length
  const warm = spawn(downloaded.result.path, [], { cwd: GATEWAY_RUN_DIR, stdio: 'ignore', windowsHide: true })
  trackChild(warm, 'gateway-warm')
  const warmDeadline = Date.now() + 25000
  while (Date.now() < warmDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) break
    } catch { /* 还没起来 */ }
    await sleep(400)
  }
  info(`第三轮之前先把网关单独起热（PID ${warm.pid}），让本轮的**首次** /v1/models 就成功`)
  const child3 = await startDsh('boot3')
  let thirdSeed
  try {
    const waited = await awaitSeed(child3, seen3, '第三轮启动')
    thirdSeed = waited.seed
    info(`boot.log 新增 ${waited.fresh.length} 行：`)
    for (const row of waited.fresh) info(`  ${redact(row)}`)
  } catch (error) {
    check('第三轮启动写出了 seed 结局行', false, String(error instanceof Error ? error.message : error).split('\n').slice(0, 3).join(' / '))
  }
  const patchText3 = existsSync(PATCH) ? readFileSync(PATCH, 'utf8') : ''
  const thirdProvider = readProviderBlock(patchText3, PROVIDER_ID)
  const firstFetchFailed = traceLines().filter((row) => row.includes('directory: FAILED')).length
  check(
    '零凭据 + 首次拉取就成功时：插件会不会写出 0 个模型的 provider',
    true,
    thirdProvider.found
      ? `**写了** providers.${PROVIDER_ID}（${thirdProvider.models} 个模型）· seed=${thirdSeed?.kind ?? '?'}`
      : `未写入 · seed=${thirdSeed?.kind ?? '?'}（整轮里 directory: FAILED 共 ${firstFetchFailed} 次）`,
  )
  note(thirdProvider.found && thirdProvider.models === 0
    ? '⇒ 与第二轮对照：差别是「首次拉取成不成功」。首次成功 ⇒ 空目录被当成正常目录写了进去。'
    : '⇒ 与第二轮对照：即便首次拉取成功，插件也没有把空目录写成 provider（那这条断点不成立）')
  killTree(child3.pid)
  untrackChild(child3.pid)
  await sleep(600)
  for (const owner of portOwners(PORT)) killTree(owner)
  untrackChild(warm.pid)
  await sleep(400)
  for (const owner of portOwners(PORT)) killTree(owner)
}
console.log(line())

/* ── 断言 4：/wb2api-setup 与 /wb2api-login 那两条路 ───────────────────── */
console.log('[4/5] /wb2api-setup 与 /wb2api-login 在无凭据时的行为')
const setupRunnerPath = join(PLUGIN_DIR, 'lib', 'setup.js')
if (!existsSync(setupRunnerPath)) {
  check('能从发布产物取到 SetupRunner', false, `${setupRunnerPath} 不存在`)
} else {
  const setupModule = await import(pathToFileURL(setupRunnerPath).href)
  const accountsPath = join(PLUGIN_DIR, 'lib', 'accounts.js')
  const accountsModule = existsSync(accountsPath) ? await import(pathToFileURL(accountsPath).href) : undefined
  // 用**真的** AccountStore（读临时树的 auths/），不造一个假的 —— 「有没有凭据」
  // 这件事必须由真代码来答。`workingDir` 指进临时树，它的 authDir() 就落在那里。
  const setupConfig = {
    baseURL: `http://127.0.0.1:${PORT}/v1`, apiKeyRef: 'WORKBUDDY2API_API_KEY', binaryPath: binaryPathInScratch,
    repoPath: '', workingDir: GATEWAY_RUN_DIR, listenPort: PORT, autoStart: true, realmPrefixPolicy: 'strip-cn',
    modelsTtlSeconds: 600, requestTimeoutSeconds: 600, idleTimeoutSeconds: 300, firstTokenTimeoutSeconds: 120,
    healthTimeoutSeconds: 3, graceMs: 5000, crashRestartLimit: 3, env: {},
    binaryReleaseRepo: binaryModule?.DEFAULT_RELEASE_REPO ?? 'rumilhz/dsh-pylon-workbuddy', binaryReleaseBase: '',
    autoDownloadBinary: false, defaultRealm: '', providerName: PROVIDER_ID, providerNamespace: SETTINGS_NS,
    writeBackupDir: join(SCRATCH, 'write-backups'), registerOwnProvider: false,
  }
  const accountStore = accountsModule?.AccountStore !== undefined
    ? new accountsModule.AccountStore({ config: setupConfig })
    : {
        authDir: () => join(GATEWAY_RUN_DIR, 'auths'),
        list: () => {
          const dir = join(GATEWAY_RUN_DIR, 'auths')
          if (!existsSync(dir)) return []
          return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => ({ uid: name, nickname: '', realm: 'cn', enabled: true, file: name }))
        },
      }
  const authFiles = (() => {
    try { return readdirSync(join(GATEWAY_RUN_DIR, 'auths')).filter((n) => n.endsWith('.json')) } catch { return [] }
  })()
  info(`临时 auths/ 里的凭证文件数：${authFiles.length}（从零的物证）`)
  // 插件在无 user-questions 服务时给用户的原文案（src/index.ts chooseRealmFromMenu），
  // 逐字抄进来，让 setup 的报告与真实命令面一致。
  const REALM_GUIDANCE =
    '需要指定登录版本：/wb2api-login cn（国内版）或 /wb2api-login global（国际版）。\n'
    + '（dsh 的 user-questions 服务不可用，无法弹出选择列表。）'

  const runner = new setupModule.SetupRunner({
    config: setupConfig,
    // 二进制：用真安装器，落点显式指进临时树（与断言 1 同一份实现）。
    installer: binaryModule === undefined
      ? { ensure: async () => { throw new Error('lib/gateway-binary.js 不在') }, prepareRuntime: () => ({ dir: GATEWAY_RUN_DIR, configPath: join(GATEWAY_RUN_DIR, 'config.json'), created: false, dirsCreated: [] }) }
      : new binaryModule.GatewayBinaryInstaller({ installDir: INSTALL_DIR, runtimeDir: GATEWAY_RUN_DIR, listenPort: PORT }),
    accountStore,
    // 登录动作：这里**不真登录**。给的是「无 user-questions 服务」时插件自己会产出的
    // 那句话（逐字来自 src/index.ts 的 chooseRealmFromMenu），用来回答「有没有明确指引」。
    performLogin: async () => ({ ok: false, detail: REALM_GUIDANCE }),
    refreshModels: async () => [],
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  })
  const outcome = await runner.run(undefined)
  const report = setupModule.renderSetupReport(outcome)
  console.log('      ── /wb2api-setup 在零凭据下给用户的回执（renderSetupReport 原文） ──')
  for (const row of report.split('\n')) console.log(`      ${redact(row)}`)
  console.log('      ── 回执结束 ──')
  const steps = outcome.steps ?? []
  const titles = steps.map((step) => `${step.status === 'ok' ? '✓' : step.status === 'skipped' ? '·' : '✗'} ${step.title}`)
  check(
    '/wb2api-setup 在零凭据下跑得完整（不抛异常、有分步汇报）',
    steps.length > 0,
    titles.join(' → '),
  )
  check(
    '① 二进制这一步在从零环境下有明确交代（ok=本次下载 / skipped=已存在且说明原因）',
    steps.some((step) => /可执行文件|下载/.test(step.title) && (step.status === 'ok' || step.status === 'skipped')),
    `${steps.find((step) => /可执行文件|下载/.test(step.title))?.status ?? '?'} —— ${steps.find((step) => /可执行文件|下载/.test(step.title))?.detail?.split('\n')[0]?.slice(0, 140) ?? '(没有这一步)'}`
    + `（断言 1 已把「空目录 → 真下载」单独证过：before=${String(EVIDENCE.binaryExistedBeforeDownload)} → after=${String(EVIDENCE.binaryExistedAfterDownload)}，所以这里的 skipped 是幂等，不是掩盖）`,
  )
  check(
    '② 无凭据时登录那一步给出**可执行的**指引（含命令与参数）',
    steps.some((step) => /登录/.test(step.title) && step.status === 'failed' && /\/wb2api-login (cn|global)/.test(step.detail)),
    steps.find((step) => /登录/.test(step.title))?.detail?.split('\n')[0]?.slice(0, 160) ?? '(没有这一步)',
  )
  check(
    '③ 编排在登录失败处停下，并明说「尚未就绪」（没有静默继续）',
    outcome.ready === false && report.includes('尚未就绪'),
    `ready=${String(outcome.ready)} · 报告末行：${report.split('\n').filter(Boolean).pop()?.slice(0, 90)}`,
  )
  // /wb2api-login 这条命令本身：静态核对它确实注册在命令面上，且无 realm 时给的两条指引
  // 与本脚本注入的那句一致（不真登录 —— 需要真账号，且会在上游创建真 state）。
  const indexSource = readFileSync(join(PLUGIN_DIR, 'src', 'index.ts'), 'utf8')
  const loginRegistered = /name:\s*'wb2api-login'/.test(indexSource)
  const guidanceVerbatim = indexSource.includes('/wb2api-login cn（国内版）或 /wb2api-login global（国际版）')
  const runSetupRegistered = /name:\s*'wb2api-setup'/.test(indexSource)
  check(
    '/wb2api-login 注册在命令面上，且无 realm 时给的是「cn/global 二选一」的明确指引',
    loginRegistered && guidanceVerbatim,
    `命令注册=${loginRegistered} · 指引文案逐字命中=${guidanceVerbatim}（未真登录：需要真账号与浏览器）`,
  )
  // 登录**能不能真的走到**，还取决于上游 OAuth 服务在这台机器上通不通。这一条只做
  // **只读**可达性探测（GET base），不申请授权链接 —— 那会在上游创建一次真的登录 state。
  if (!SKIP_NET) {
    const loginModule = existsSync(join(PLUGIN_DIR, 'lib', 'login.js'))
      ? await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'login.js')).href)
      : undefined
    const realms = ['cn', 'global']
    const results = []
    for (const realm of realms) {
      const endpoints = loginModule?.realmEndpoints?.(realm)
      if (endpoints === undefined) { results.push(`${realm}: (端点表不可得)`); continue }
      const probe = await probeUrl(`${endpoints.base}/`, 15000)
      results.push(`${realm} ${endpoints.base} → ${probe.ok ? `HTTP ${probe.status}` : (probe.error ?? `HTTP ${probe.status}`)} (${probe.ms}ms)`)
    }
    const anyReachable = results.some((row) => /→ HTTP 2\d\d|→ HTTP 3\d\d/.test(row))
    check(
      '登录入口的网络侧可达（只读探测上游 OAuth 站点；未申请授权链接）',
      anyReachable,
      results.join(' · '),
    )
  }
}
console.log(line())

/* ── 断言 5：收尾 ───────────────────────────────────────────────────────── */
console.log('[5/5] 收尾：进程 + 端口 + 活体 home 未被写')
// `--capture`：把子进程输出（含用户文案）落盘。默认不落盘 —— 那里面可能带网关 token，
// 工作区里不该出现这种文件；默认只在内存里过滤 + redact 后展示。
if (CAPTURE && childOutput.length > 0) {
  const dump = join(SCRATCH, 'fromscratch-child-output.log')
  try {
    writeFileSync(dump, `${childOutput.map((entry) => `${entry.label}/${entry.tag}  ${entry.row}`).join('\n')}\n`, 'utf8')
    info(`--capture：子进程输出 ${childOutput.length} 行已落 ${dump}`)
  } catch (error) {
    info(`--capture：落盘失败（不影响结论）：${error instanceof Error ? error.message : String(error)}`)
  }
}
const stragglers = [...liveChildren].filter(isAlive)
if (stragglers.length > 0) {
  console.log(`🔴 仍有本脚本启动的进程活着：${stragglers.join(', ')} —— 正在补杀`)
  killAllOurChildren('收尾')
}
const finalOwners = portOwners(PORT)
check(
  `结束时端口 ${PORT} 无残留监听`,
  finalOwners.length === 0,
  finalOwners.length === 0 ? '空闲' : `仍被 PID ${finalOwners.join(', ')} 占用`,
)
const liveDiffs = liveUnchanged()
check(
  '活体 ~/.dsh/wb2api 与 ~/.dsh/.wb2api 全程未被本脚本写过',
  liveDiffs.length === 0,
  liveDiffs.length === 0
    ? `只读快照前后一致（gateway ${LIVE_BEFORE.gateway.exists ? '存在' : '不存在'}）`
    : liveDiffs.join(' / '),
)
const scratchChildren = existsSync(SCRATCH) ? readdirSync(SCRATCH) : []
check(
  '临时树形状可解释（没有跑到别处落文件）',
  scratchChildren.every((name) => ['home', 'gateway', 'write-backups', 'fromscratch-pids.json'].includes(name) || name.startsWith('fromscratch-')),
  scratchChildren.join(', ') || '(空)',
)
console.log(line('='))

/* ── 结论 ───────────────────────────────────────────────────────────────── */
const passed = checks.filter((entry) => entry.passed).length
for (const entry of checks) if (!entry.passed) console.log(`  FAIL  ${entry.name}  — ${entry.evidence}`)
const ok = failures === 0
console.log('结论')
console.log(line('='))
console.log(`${ok ? '✅' : '🔴'} 五条断言：${passed}/${checks.length} PASS`)
console.log(`   ① 二进制下载   ${downloaded.ran !== true ? '未跑' : downloaded.result !== undefined ? `通（${downloaded.size} B · 归档/清单/落盘三方 hash 一致）` : `**不通** —— ${String(downloaded.error ?? '').split('\n')[0]}`}`)
console.log(`   ② 无凭据行为   ${seed === undefined ? '未拿到 seed 行' : `第一轮 seed: ${seed.kind}`} · 第二轮 seed: ${secondSeed?.kind ?? '(未跑)'}`)
console.log(`   ③ /v1/models   ${modelsBody === undefined ? '未实测' : `HTTP ${modelsBody.status} · ${modelsBody.body.slice(0, 60)}`}`)
console.log(`   ④ 登录入口     ${checks.find((entry) => entry.name.startsWith('/wb2api-login 注册'))?.passed === true ? '指引明确（未真登录）' : '见上面 FAIL'}`)
console.log(`   ⑤ 收尾        端口${finalOwners.length === 0 ? '空闲' : `仍被占用 ${finalOwners.join(', ')}`} · 活体 home ${liveDiffs.length === 0 ? '未被动过' : '**被动过**'}`)
console.log(`   ★ 0 模型 provider：${secondProvider.found && secondProvider.models === 0 ? `**会写**（providers.${PROVIDER_ID} · 0 个模型）` : secondProvider.found ? `写了 ${secondProvider.models} 个模型` : '未写入'}`)
console.log('')
console.log('   本脚本**没有**借用的东西：活体 ~/.dsh/wb2api 的二进制、auths/ 里的凭证、config.json 一律没碰。')
console.log(`   本次运行 ${seconds(Date.now() - runStarted)} · 临时树 ${SCRATCH}`)

/* ── 清理 ───────────────────────────────────────────────────────────────── */
if (KEEP_SCRATCH) {
  console.log(`   --keep-scratch：保留临时树（删除：rmdir /s /q "${SCRATCH}"）`)
} else if (ok) {
  try {
    if (existsSync(junction)) rmSync(junction, { force: true, recursive: false })
    rmSync(SCRATCH, { recursive: true, force: true })
    console.log(`   清理：已删除临时树（含下载来的二进制）${existsSync(SCRATCH) ? ' —— 但目录还在！' : ''}`)
  } catch (error) {
    console.log(`   ⚠ 清理临时树失败（不影响结论）：${error instanceof Error ? error.message : String(error)}`)
  }
} else {
  console.log(`   保留临时树便于排查（boot.log：${TRACE}）；删除：rmdir /s /q "${SCRATCH}"`)
}
console.log(line('='))
process.exit(ok ? 0 : 1)
