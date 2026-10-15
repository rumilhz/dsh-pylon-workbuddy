/**
 * 一条命令跑完全部闸门（A2）。
 *
 *   <node> tools/_run-suites.mjs                 离线：类型检查 / 单测 / 可移植性 / 本地 e2e / CLI 契约 / 构建
 *   <node> tools/_run-suites.mjs --network       追加「真实网关」集成（联网，真实对话会花额度）
 *   <node> tools/_run-suites.mjs --no-build      不跑表尾的构建（调用方自己构建，见下）
 *   <node> tools/_run-suites.mjs --skip unit     跳过标签含 "unit" 的套件（可重复，也支持 --skip=unit）
 *   <node> tools/_run-suites.mjs --help          打印这张表就退出
 *
 * 两条不可动摇的规矩：
 *   ① **缺失的入口记 SKIP，绝不记成 PASS** —— "这条检查没跑" 与 "这条检查过了"
 *      不能长得一样。SKIP 不影响退出码，但汇总里会逐个点名。
 *   ② 只看子进程**退出码**，不解析它的输出；FAIL 时只回放末尾 3 行，不刷屏。
 *
 * ## 这个脚本就是 CI 的测试步（2026-10-15 起）
 *
 * 起因是一条**系统性**的假绿：`.github/workflows/*.yml` 以前只跑 `vitest run`，而
 * `vitest.config.ts` 的 include 只有 `tests/unit/**` ⇒ `tests/e2e/**`（写路径安全网、
 * CLI 离线契约）**从来没进过 CI**。本地之所以"全绿"，靠的恰恰是那台机器上活着的网关 ——
 * 假绿只在开发机上骗人，CI 上是空白。
 *
 * 所以 workflow 里现在写的是 `node tools/_run-suites.mjs`，而不是一串散装命令：
 * 加了新的离线闸门时，CI 自动跟着走，不需要有人记得去改 YAML。
 *
 * ## `--no-build` 是给谁用的（为什么不是默认）
 *
 * 表尾那条 `build` 会 emit 到 `lib/`。有的 workflow（`release-plugin.yml`）紧接着
 * 自己就要 `tsc -p tsconfig.json` 建 `lib/` 并**逐文件断言产物**、再 `npm pack` ——
 * 那里再跑一遍就是重复做功。给它 `--no-build` 后，这条**不进 SUITES**，但也不是
 * 悄悄消失：它照旧在表里、照旧打印一行 SKIP 及原因（见规矩①）。
 * 反过来，`ci.yml` 用**不带** `--no-build` 的那份：那条工作流没有自己的构建步，
 * 产物断言直接吃本脚本建出来的 `lib/`。
 *
 * 表是**硬编码**的（不扫目录：扫目录会把临时文件、备份当成套件）。
 * 套件入口都在 node_modules 里，所以依赖没装时整张表都会 SKIP —— 这是故意的，
 * 那正是"没跑"，不是"过了"。
 *
 * 为什么 live gateway 那一条要先判环境变量：`tests/e2e/live-gateway.spec.ts` 用
 * `describe.skipIf(!ENABLED)` 自己跳过，而 vitest 对"自己跳过的用例"退出码仍是 0 ——
 * 直接跑会把一个**一个字都没执行**的套件报成 PASS。所以这里先看它自己的开关，
 * 没开就记 SKIP 并把开法写进原因里。
 *
 * `tools/wb2api.mjs` 是**独立于插件的第二入口**，它不在 `tests/unit/**` 的 include 里，
 * 所以单独一条 `cli 离线契约`。这条同样按 `{ skip }` 进表：CLI 或它的 spec 缺任一个
 * 都留一行显式 SKIP，而不是从表里消失（理由见上面规矩①）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const NODE = process.env['DSH_NODE'] ?? process.execPath
const HERE = import.meta.dirname // Node ≥20.11；中文路径安全（别用 new URL(import.meta.url).pathname）
const ROOT = join(HERE, '..')

const argv = process.argv.slice(2)
const NETWORK = argv.includes('--network')
const NO_BUILD = argv.includes('--no-build')
const HELP = argv.includes('--help') || argv.includes('-h')
const SKIP_FLAGS = [
  ...argv.flatMap((value, index) => (value === '--skip' ? [argv[index + 1] ?? ''] : [])),
  ...argv.filter((value) => value.startsWith('--skip=')).map((value) => value.slice('--skip='.length)),
].filter((value) => value !== '').map((value) => value.toLowerCase())

/** 子进程入口（相对 ROOT）：写死路径，缺了就是 SKIP，不去猜别的入口名。 */
const TSC = 'node_modules/typescript/bin/tsc'
const VITEST = 'node_modules/vitest/vitest.mjs'
const E2E_CONFIG = 'vitest.e2e.config.ts'
const SPEC_LOCAL = 'tests/e2e/write-guard-fs.spec.ts' // 纯本地文件系统，默认跑
const CLI_TOOL = 'tools/wb2api.mjs' // 独立 CLI（不经 dsh 插件）
const SPEC_CLI = 'tests/e2e/cli-offline.spec.ts' // 上面那个 CLI 的离线契约
const CLIENT_CHECK = 'tools/client-bundle-check.mjs' // 浏览器半边（设置卡片）的离线闸门
/** 上面那支闸门的自我启动入口：node 直接跑它，它再跑闸门（见行尾注释）。 */
const CLIENT_LAUNCH = 'tools/client-bundle-check.run.mjs'
const SPEC_LIVE = 'tests/e2e/live-gateway.spec.ts' // 打真网关 + 真实对话，默认不跑
const DEFAULT_TIMEOUT_MS = 180_000
const NETWORK_TIMEOUT_MS = 600_000 // live spec 自己的 testTimeout 是 300s，别在这里先把它掐死

const LIVE_ENABLED =
  process.env['DSH_WB2API_E2E'] === '1' && process.env['DSH_WB2API_E2E_CONFIRM'] === 'yes'
const LIVE_HINT =
  '未开启：需要 DSH_WB2API_E2E=1 与 DSH_WB2API_E2E_CONFIRM=yes（否则 spec 自己 skip，退出码 0 会伪装成 PASS）'

/**
 * 独立 CLI 那条套件的 SKIP 原因（`undefined` = 该跑）。
 *
 * 它有两个入口（CLI 本体 + 契约 spec），**缺任一个都记 SKIP、留在表里** —— 见文件头规矩①。
 * 这里刻意不用 `SPEC_LOCAL` 那种"整行条件展开"的写法：行没了，汇总里就只剩一个
 * 说不清是"已通过"还是"根本没这条"的空白，而 CLI 被删/改名恰恰是最容易悄悄发生的事。
 * 显式 SKIP 会连原因一起打印出来。
 */
const CLI_SKIP =
  !existsSync(join(ROOT, CLI_TOOL)) ? `${CLI_TOOL} 不存在（独立 CLI 未提供？）`
    : !existsSync(join(ROOT, SPEC_CLI)) ? `${SPEC_CLI} 不存在`
      : undefined

/**
 * 期望值可移植性那条的 SKIP 原因（`undefined` = 该跑）。
 *
 * 它扫 `tests/**` 的**期望值**，拦"没写平台守卫、却把路径分隔符写死在期望值里"的断言
 * —— 那类断言在本地（正是那台机器）永远绿，只在别的平台上红，于是每次都要等推到 CI
 * 才知道。工具的用法与判据见 `tools/platform-path-lint.mjs` 文件头。
 *
 * 它靠 `node_modules/typescript` 解析 AST（grep 会把几十处**入参**误报成违规，
 * 那种检查活不过一周）。typescript 不在时显式记 SKIP，绝不当成 PASS —— 见规矩①。
 */
const LINT_TOOL = 'tools/platform-path-lint.mjs'
const LINT_SKIP =
  !existsSync(join(ROOT, LINT_TOOL)) ? `${LINT_TOOL} 不存在（可移植性闸门未提供？）`
    : !existsSync(join(ROOT, TSC)) ? `${TSC} 不存在（typescript 没装，无法解析 AST）`
      : undefined

/**
 * 浏览器半边那条的 SKIP 原因（`undefined` = 该跑）。
 *
 * 这条套件是**一支独立脚本**（不是 vitest 用例），它的入口是 `CLIENT_LAUNCH`：
 * 一个仓库内的真实文件，自己 import 并执行真正的闸门 `CLIENT_CHECK`，然后把闸门的
 * 退出码原样传出去。这样做是为了让本表的 `existsSync(join(ROOT, entry))` 判定成立 ——
 * 本表不认 `node_modules` 之外的绝对入口（`join(ROOT, "D:\\...\\node.exe")` 在 Windows
 * 上会把盘符当普通目录名拼起来，于是"入口不存在"会假报成"依赖没装"）。
 * 闸门脚本被删/改名时，这里显式记 SKIP —— 见文件头规矩①。
 *
 * 哨兵 2 已废除。闸门在运行期发现 `client/client.js` 不在时，现在**直接以退出码 1 失败**。
 * 理由：那是被 git 跟踪的**手写源文件**，丢了就是坏检出，不是"还没落地"。
 * 原来那个 2 ⇒ SKIP 的翻译正是本次发布阻塞的根源 —— 缺了卡片文件，套件显示
 * 「5 PASS · 1 SKIP」，而 SKIP 不影响退出码，于是发布闸门全绿。
 *
 * 注意区分（两者不再混为一谈）：
 *   · 套件**入口**不存在（依赖没装、工具没提供）⇒ 仍然是 SKIP，见规矩①；
 *   · 已经跑起来的套件**非 0 退出** ⇒ 一律 FAIL。
 */
const CLIENT_SKIP =
  !existsSync(join(ROOT, CLIENT_CHECK)) ? `${CLIENT_CHECK} 不存在（浏览器半边未提供？）`
    : !existsSync(join(ROOT, CLIENT_LAUNCH)) ? `${CLIENT_LAUNCH} 不存在（入口缺了）`
      : undefined

/**
 * 构建那条的 SKIP 原因（`undefined` = 该跑）。
 *
 * `--no-build` 的用法与理由见文件头。这里要强调的只有一点：**它不是 PASS** ——
 * 表里照样有一行 SKIP、汇总里照样点名，只是退出码不受影响（规矩①）。
 * 谁用了这个开关，谁就欠一次自己的构建与产物断言。
 */
const BUILD_SKIP = NO_BUILD
  ? '被 --no-build 排除：调用方自己构建并断言产物（如 release-plugin.yml 的 Build lib/ 步）'
  : undefined

/** [标签, 入口(相对 ROOT), 参数, { skip?, timeoutMs? }?] */
const SUITES = [
  ['typecheck (tsc --noEmit)', TSC, ['-p', 'tsconfig.json', '--noEmit']],
  ['unit (vitest run tests/unit)', VITEST, ['run']],
  // 期望值可移植性：拦"本地那台机器替你掩盖了它在别的平台上会红"的断言。
  // 本地是 Windows、CI 是 Linux，这类断言只有出了本地才炸 —— 所以它必须是一条
  // **本地基线里的**闸门，而不是等 CI 报。判据与用法见那个工具的文件头。
  ['test 可移植性 (期望值不写死路径分隔符)', LINT_TOOL, [], { skip: LINT_SKIP }],
  // 条件展开：这条 e2e 的 spec 是仓库的一部分，被删/改名时记 SKIP 而不是让 vitest 报"找不到用例"
  ...(existsSync(join(ROOT, SPEC_LOCAL))
    ? [['e2e 写路径安全网 (真实文件系统, 离线)', VITEST, ['run', '--config', E2E_CONFIG, SPEC_LOCAL]]]
    : []),
  // 独立 CLI 的离线契约：--help / 未知命令 / test 缺 --model —— 三条都只读参数、不发请求。
  // `test` 是那个 CLI 里唯一会花额度的命令，所以"缺参数在拨号前就被拦住"值得钉住。
  [
    'cli 离线契约 (tools/wb2api.mjs 参数与退出码)',
    VITEST,
    ['run', '--config', E2E_CONFIG, SPEC_CLI],
    { skip: CLI_SKIP },
  ],
  // 浏览器半边（设置卡片 client/client.js）的离线闸门：不用浏览器就能证明它是经典脚本、
  // id 严格等于包名、两个席位/四个 key、双前缀只在"不是 JSON"时才换、四种状态都能渲染、
  // 且签到/重建清单/测试模型三个按钮都只在点了之后才发请求。
  // 入口见上面 CLIENT_SKIP 的说明。
  [
    'client bundle 离线闸门 (client/client.js 加载契约 + 双前缀 + 四状态)',
    CLIENT_LAUNCH,
    [],
    { skip: CLIENT_SKIP },
  ],
  ['build (tsc -p tsconfig.json → lib/)', TSC, ['-p', 'tsconfig.json'], { skip: BUILD_SKIP }],
  // 联网组：只有 --network 才进表（不进表 = 这条本就不在本次范围内，表尾会说明）
  ...(NETWORK
    ? [[
        'e2e live gateway (联网, 真实对话会花额度)',
        VITEST,
        ['run', '--config', E2E_CONFIG, SPEC_LIVE],
        { skip: LIVE_ENABLED ? undefined : LIVE_HINT, timeoutMs: NETWORK_TIMEOUT_MS },
      ]]
    : []),
]

const clock = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)
const line = (char = '-', width = 78) => char.repeat(width)

if (HELP) {
  console.log('用法：node tools/_run-suites.mjs [--network] [--no-build] [--skip <关键字>]... [--help]')
  console.log('')
  console.log(`本次${NETWORK ? '包含' : '不含'}联网套件（--network 控制）。表：`)
  for (const [label, entry, args = [], options = {}] of SUITES) {
    console.log(`  - ${label}`)
    console.log(`      ${NODE} ${entry} ${args.join(' ')}`.trimEnd())
    // 已经注定跳过的那几条（--no-build）在帮助里就写明，免得"表里有、跑起来没有"。
    if (options.skip !== undefined) console.log(`      （本次跳过：${options.skip}）`)
  }
  console.log('')
  console.log('判定：退出码 0 ⇒ PASS；入口不存在 ⇒ SKIP（绝不算 PASS）；有 FAIL ⇒ 本脚本退出码 1。')
  process.exit(0)
}

console.log(`suite runner · ${ROOT}`)
console.log(`node ${NODE} · ${NETWORK ? '含联网套件' : '仅离线（--network 可加联网套件）'}`
  + (NO_BUILD ? ' · --no-build（构建那条改由调用方负责，下面会记 SKIP）' : ''))
console.log(line())

const results = []
for (const [label, entry, args = [], options = {}] of SUITES) {
  const record = (status, detail) => {
    results.push({ label, status, detail })
    console.log(`${status}  ${label}  (${detail})`)
  }
  const forced = SKIP_FLAGS.find((pattern) => label.toLowerCase().includes(pattern))
  if (forced !== undefined) {
    record('SKIP', `被 --skip "${forced}" 排除`) // 用户显式排除：明说，不算通过
    continue
  }
  if (options.skip !== undefined) {
    record('SKIP', options.skip)
    continue
  }
  const path = join(ROOT, entry)
  if (!existsSync(path)) {
    record('SKIP', `${entry} 不存在（依赖没装？）`)
    continue
  }

  const started = Date.now()
  const run = spawnSync(NODE, [path, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    windowsHide: true,
  })
  const elapsed = clock(Date.now() - started)
  // 哨兵 2（"套件自报未运行"）已废除，见文件头 CLIENT_SKIP 段。它唯一的产出是让
  // "卡片文件 client/client.js 不在"变成一条不影响退出码的 SKIP —— 发布闸门因此全绿地
  // 发出一个没有卡片的版本。缺失的**入口**仍由上面的 existsSync / `{ skip }` 记 SKIP
  // （那是"依赖没装"，不是"检出坏了"），两者不再混为一谈。
  //
  // 顺带堵掉一个同族隐患：`tsc -p tsconfig.json`（emit 模式）在"有诊断但产物已生成"时
  // 退出码正是 2 —— 原来那一支会把一个**有编译错误**的构建报成 SKIP。
  const ok = run.status === 0 // 只看退出码；status 为 null（超时/起不来）自然算 FAIL
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const source = output.trim() === '' && run.error !== undefined ? run.error.message : output
  const tail = source.trim().split(/\r?\n/).slice(-3).join(' | ') // 只留末尾 3 行
  const signal = run.signal === null || run.signal === undefined ? '' : ` [${run.signal}]`
  results.push({ label, status: ok ? 'PASS' : 'FAIL', detail: elapsed })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${elapsed})${ok ? '' : `${signal}\n      ${tail.slice(0, 400)}`}`)
}

const passed = results.filter((row) => row.status === 'PASS')
const failed = results.filter((row) => row.status === 'FAIL')
const skipped = results.filter((row) => row.status === 'SKIP')

console.log(line())
console.log(
  `${results.length} 条：${passed.length} PASS · ${failed.length} FAIL · ${skipped.length} SKIP` +
    (NETWORK ? ' · 含联网套件' : ' · 仅离线（--network 可加 live gateway）'),
)
for (const row of skipped) console.log(`  SKIP: ${row.label} —— ${row.detail}`)
for (const row of failed) console.log(`  FAILED: ${row.label}`)
if (skipped.length > 0) console.log('提示：SKIP 是"这条没跑"，不是"这条过了"；本脚本退出码不受 SKIP 影响。')
process.exit(failed.length === 0 ? 0 : 1)
