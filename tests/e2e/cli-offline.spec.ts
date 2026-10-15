/**
 * `tools/wb2api.mjs`（独立 CLI，不经 dsh 插件）的**离线**契约。
 *
 * 这个文件存在的起因很具体：那个 CLI 是独立于插件的第二入口，不在 `tests/unit/**`
 * 的覆盖里，于是它可以被改坏而**全绿套件一个字都不说**。这里只钉住**不该发请求**的
 * 行为 —— 参数校验与退出码，也就是"人和脚本都靠它判断下一步"的那一层：
 *
 *   ① `--help` / `-h` ⇒ 0，而且**根本不读 config**；
 *   ② 未知命令 ⇒ 2（用法错，与"网关不可达"的 1 分开）；
 *   ③ `test` 缺 `--model` ⇒ 2，且在联网之前就返回；
 *   ④ `test` 的两道成本闸（模型不在目录里 / 没给 `--yes`）⇒ 2，
 *      且**一条会花额度的请求都没发**；
 *   ⑤ **未知选项 / 写错的选项 ⇒ 2**（`-j` / `-y` / `--nonexistent` / `--limit=30` /
 *      选项缺值），同样在联网之前返回，并且**一条请求都不发**。
 *
 * ③ ④ 是最要紧的：`test` 是那个 CLI 里**唯一会花额度**的命令，而"缺参数"与"闸门"
 * 必须在拨号之前就被拦住 —— 否则一次笔误就是一次真实消费。
 *
 * ⑤ 是 2026-10-15 补的，症状和 ①② 同族但更隐蔽：`-j` 之类**认不出的短横线词**
 * 以前被**静默忽略**。`command` 取的是「第一个不以 `-` 开头的词」，于是 `wb2api -j`
 * 里没有任何词能当命令 ⇒ 落到默认值 `status` ⇒ **真去打了一趟网关**。
 * 用户以为 `-j` 是 json，实际做的是另一件事，而且退出码还是 0（网关活着时）。
 * 所以下面那三条一律**指向活着的假网关**再断言"一条请求都没发" —— 用死端口的话，
 * 旧行为会先以"网关不可达"(1) 失败，正好把"它去拨号了"这件事掩盖过去（同 ③④ 的坑）。
 *
 * ## 离线性是构造出来的，不是假设的（2026-10-15 修掉一轮假绿）
 *
 *   · 所有断言都走 `--config <临时文件>`，指向只存在于本次临时目录里的 config.json。
 *     这样既不依赖本机 `~/.dsh/wb2api/config.json` 是否存在（CI 上没有 ⇒ 会变成退出码
 *     1 而不是 2，把一条环境差异伪装成失败），也不会碰到真实网关。
 *
 *   · 帮助那两条**以前没带 `--config`**（走本机默认配置）。本机默认配置里
 *     `listen=127.0.0.1:7863` 且网关活着、key 是真的 ⇒ 断言"要么绿、要么被真网关救活"：
 *     `-h` 当时**不是**一个被认出的 flag，于是 `command` 落到默认值 `status`，
 *     真去打了一趟活体网关，**退出 0** ⇒ `-h ⇒ 0` 绿了，而 `-h` 本身是坏的
 *     （同一天在真 Linux 上实测：`-h --config <不存在>` 退出 1）。
 *     现在两条都带 config，并且额外用"config 根本不存在"再跑一遍：帮助路径若真去读
 *     配置，那里必然退 1。
 *
 *   · 成本闸那两条**以前指向死端口** ⇒ 进程在"网关不可达"那一步就退 1，**根本走不到
 *     闸门**（把那两道闸整个删掉，那两条照样绿）。现在起一个**本地假网关**回答目录，
 *     才能把"拒绝发那条会花额度的消息"钉在**成本闸**上，而不是钉在"连不上"上。
 *
 * 为什么断言的是**退出码**而不是输出文本：退出码才是 `_run-suites.mjs` 与 shell 脚本
 * 依赖的契约，文案可以改，退出码不能。个别地方连文本一起钉，是因为**只**看退出码
 * 分不出"打了帮助"与"打了网关"（两者都可能是 0）。
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const CLI = join(ROOT, 'tools', 'wb2api.mjs')
const execFileAsync = promisify(execFile)

/** 一个**必然连不上**的网关地址：走到拨号的断言会以退出码 1 失败，而不是静默变绿。 */
const DEAD_ORIGIN = '127.0.0.1:9'

/** 假网关目录里那个**免费**模型：它的存在让流程能走到 `--yes` 那道闸。 */
const FREE_MODEL_ID = 'cn:fixture-free'

/** 帮助文本里唯一那句只可能出现在帮助里的特征串（status 输出里没有它）。 */
const HELP_MARKER = '用法：'

const API_KEY = 'fixture-key-not-a-real-credential'

let tempDir: string
/** 指向死端口的 config：用来构造"网关不可达"的环境。 */
let deadConfigPath: string
/** 指向本地假网关的 config：只在成本闸那两条里用。 */
let fakeConfigPath: string

/** 假网关收到的每一次请求（按到达顺序）—— 断言"一条花额度的请求都没发"就靠它。 */
const gatewayHits: Array<{ method: string; url: string }> = []
let gateway: Server

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'wb2api-cli-'))
  deadConfigPath = join(tempDir, 'config.json')
  writeFileSync(deadConfigPath, JSON.stringify({ listen: DEAD_ORIGIN, api_key: API_KEY }))

  // 本地假网关：只回答 /v1/models 目录（含一个免费模型），其余路径也回一段 JSON ——
  // 若哪天真有被测代码走到 /chat/completions，那是"发出了一条会花钱的消息"，
  // 由 gatewayHits 上的断言抓住，而不是靠这里的响应内容。
  gateway = createServer((request, response) => {
    const url = request.url ?? ''
    gatewayHits.push({ method: request.method ?? '', url })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(url.endsWith('/v1/models')
      ? JSON.stringify({ data: [{ id: FREE_MODEL_ID, name: 'fixture', credits: 'x0.00' }] })
      : JSON.stringify({ choices: [{ message: { role: 'assistant', content: '不该被调用' } }] }))
  })
  await new Promise<void>((resolve) => { gateway.listen(0, '127.0.0.1', () => resolve()) })
  const { port } = gateway.address() as AddressInfo
  fakeConfigPath = join(tempDir, 'fake-gateway.json')
  writeFileSync(fakeConfigPath, JSON.stringify({ listen: `127.0.0.1:${port}`, api_key: API_KEY }))
})

afterAll(async () => {
  // close() 会等既有连接自然结束，而 undici 的 keep-alive 连接不会自己关 ⇒ 先掐连接，
  // 否则这条钩子会挂到 hookTimeout。
  gateway.closeAllConnections()
  await new Promise<void>((resolve) => { gateway.close(() => resolve()) })
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // 忽略清理失败。
  }
})

/**
 * 跑一次 CLI 并拿回退出码 + 输出（0 与非 0 都走同一条返回路径）。
 *
 * ⚠️ 必须用**异步**的 `execFile`，不能图省事写 `spawnSync`：同步版会把本测试进程的
 * 事件循环钉住，于是本进程里那个**假网关一个请求都处理不了** —— 被测 CLI 会一直等到
 * 自己的 20s 超时，跑出"网关不可达"的假失败（2026-10-15 实测踩过这一脚）。
 *
 * `timeout` 也不能省：这些断言本该**立即**返回，若哪天有人在参数校验之前插了网络调用，
 * 这里要的是"快速失败"（超时被杀 ⇒ status 为 null ⇒ 断言红），而不是让套件挂死。
 */
async function runCli(args: string[]): Promise<{ status: number | null; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })
    return { status: 0, output: `${stdout}${stderr}` }
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string }
    return {
      status: typeof failure.code === 'number' ? failure.code : null,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    }
  }
}

describe('tools/wb2api.mjs：离线契约（不发请求）', () => {
  it('--help ⇒ 退出 0，且打的是帮助', async () => {
    const { status, output } = await runCli(['--help', '--config', deadConfigPath])
    expect(status).toBe(0)
    // 帮助里必须能看到各命令与退出码表 —— 否则"帮助"帮不了人。
    expect(output).toContain('status')
    expect(output).toContain('models')
    expect(output).toContain('usage')
    expect(output).toContain('test')
    // 退出码 0 也可能是"打了网关"（网关活着时 status 也退 0）⇒ 用帮助独有的那行区分。
    expect(output).toContain(HELP_MARKER)
  })

  it('-h ⇒ 退出 0（与 --help 同一条路，不是"掉进 status"）', async () => {
    // 这条曾经是假绿：`-h` 没被认出来 ⇒ command 落到默认值 status ⇒ 去拨本机活体网关
    // （7863，真 key）⇒ 退出 0。于是它在开发机永远绿，在真 Linux 上必红。
    const { status, output } = await runCli(['-h', '--config', deadConfigPath])
    expect(status).toBe(0)
    expect(output).toContain(HELP_MARKER)
  })

  it('帮助路径压根不读 config：--config 指向不存在的文件也退 0', async () => {
    // 比"死端口"更狠的一刀：死端口只证明"没拨通"，这条证明**连配置都没去读**。
    const missing = join(tempDir, 'definitely-missing.json')
    for (const arg of ['--help', '-h']) {
      const { status, output } = await runCli([arg, '--config', missing])
      expect(status, `${arg} 去读了 config（应该直接打帮助）`).toBe(0)
      expect(output).toContain(HELP_MARKER)
    }
  })

  it('未知命令 ⇒ 退出 2（用法错，不是"网关不可达"的 1）', async () => {
    const { status, output } = await runCli(['definitely-not-a-command', '--config', deadConfigPath])
    expect(status).toBe(2)
    expect(output).toContain('definitely-not-a-command')
  })

  /**
   * ⑤ 三条一组：认不出的选项 ⇒ 退出 2，且**一条请求都不发**。
   *
   * 为什么必须对着**活着的**假网关断言：这三条断言的核心是"它没有去拨号"。
   * 对着死端口跑的话，旧行为（静默落到 `status`）会以"网关不可达"(1) 失败，
   * 而"它其实拨号了"这件事就被掩盖了 —— 那正是 ③④ 里踩过的坑。
   */
  it('-j ⇒ 退出 2（--json 没有短别名），且在拨号前返回；提示里给出 --json', async () => {
    const before = gatewayHits.length
    const { status, output } = await runCli(['-j', '--config', fakeConfigPath])
    expect(gatewayHits).toHaveLength(before) // ★ 安全性：一条请求都没发
    expect(status).toBe(2)
    expect(output).toContain('未知选项 -j')
    // 帮助文本要能让人看懂"为什么 -j 不认"：说清长写法，而不是只说一句"未知"。
    expect(output).toContain('--json')
  })

  it('-y ⇒ 退出 2（--yes 没有短别名），且在拨号前返回', async () => {
    const before = gatewayHits.length
    const { status, output } = await runCli(['-y', '--config', fakeConfigPath])
    expect(gatewayHits).toHaveLength(before)
    expect(status).toBe(2)
    expect(output).toContain('未知选项 -y')
    expect(output).toContain('--yes')
  })

  it('--nonexistent ⇒ 退出 2，且在拨号前返回', async () => {
    const before = gatewayHits.length
    const { status, output } = await runCli(['--nonexistent', '--config', fakeConfigPath])
    expect(gatewayHits).toHaveLength(before)
    expect(status).toBe(2)
    expect(output).toContain('未知选项 --nonexistent')
  })

  it('帮助里写的选项 = 解析器认的选项（两个方向都查）', async () => {
    // `-h` 那次假绿的**反方向**：帮助里明写「--help, -h」，解析器却不认 `-h` ⇒
    // 它掉进默认命令 `status` 去拨了活体网关（本机绿、Linux 红）。
    // 反过来同样有害：悄悄多认一个选项、帮助里从不提它，用户只能靠报错去猜。
    // 这里把两个方向钉在一起 —— 白名单在 tools/wb2api.mjs 的 VALUE_OPTIONS/FLAG_OPTIONS
    // 里（那个脚本是**立即执行的**，import 它会真的跑起来，所以只能读源码取表）。
    const { status, output } = await runCli(['--help', '--config', deadConfigPath])
    expect(status).toBe(0)

    const source = readFileSync(CLI, 'utf8')
    const listOf = (name: string): string[] => {
      const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source)
      if (match === null) throw new Error(`tools/wb2api.mjs 里找不到 ${name}（表被改名了？）`)
      return [...match[1]!.matchAll(/'([a-z-]+)'/g)].map((entry) => entry[1]!)
    }
    const declared = [...listOf('VALUE_OPTIONS'), ...listOf('FLAG_OPTIONS')]
    expect(declared.length).toBeGreaterThan(8) // 表本身别被解析成空数组（否则下面两条恒真）

    // 正方向：白名单里每一个都得在帮助里出现。
    for (const name of declared) expect(output, `帮助里没写 --${name}`).toContain(`--${name}`)
    // 反方向：帮助里提到的每个**长选项**都必须真被接受。
    // （只查 `--`：帮助里用 `-j` 之类当反例，那些本来就不该被接受。）
    const mentioned = [...new Set([...output.matchAll(/--([a-z][a-z-]*)/g)].map((entry) => entry[1]!))]
    for (const name of mentioned) expect(declared, `帮助提到了但解析器不认：--${name}`).toContain(name)
  })

  it('选项写法写错也拦：--limit=30 不认；选项后面该有值却没有（--config 结尾）⇒ 2', async () => {
    // 同一个病根的两种形态：把「认不出来」变成「按默认值静默跑」。
    // `--limit=30` 以前整串被忽略、按默认 20 跑；`--config` 后面空着以前直接回落默认配置。
    const before = gatewayHits.length
    const inline = await runCli(['models', '--limit=30', '--config', fakeConfigPath])
    expect(inline.status).toBe(2)
    expect(inline.output).toContain('未知选项 --limit=30')

    const dangling = await runCli(['status', '--config'])
    expect(dangling.status).toBe(2)
    expect(dangling.output).toContain('缺一个值')

    expect(gatewayHits).toHaveLength(before)
  })

  it('test 缺 --model ⇒ 退出 2，且在联网之前就返回', async () => {
    const { status, output } = await runCli(['test', '--config', deadConfigPath])
    expect(status).toBe(2)
    // 退出码 2 已经说明它在拨号前返回了；这里再把"它到底说了什么"钉住，
    // 免得将来有人把这个分支改成别的失败原因而退出码恰好还是 2。
    expect(output).toContain('--model')
  })

  it('test --model 但没 --yes ⇒ 退出 2，且一条会花额度的请求都没发', async () => {
    // ★ 假网关（不是死端口）才让这条断言真的在测**成本闸**：模型在目录里、单价 x0.00，
    // 唯一还能拦住它的就是 --yes。若把 --yes 那道闸删掉，这里会退 0 并发出真实 POST。
    const before = gatewayHits.length
    const { status, output } = await runCli(['test', '--model', FREE_MODEL_ID, '--config', fakeConfigPath])

    // ★ 安全属性排在最前：一条会花额度的请求都不许发出去。
    // 成本闸要先读目录才知道单价 ⇒ 会有 GET；但绝不能有 /chat/completions。
    const calls = gatewayHits.slice(before)
    expect(calls.some(call => call.url.includes('/chat/completions'))).toBe(false)
    expect(calls.every(call => call.method === 'GET')).toBe(true)
    expect(calls.length).toBeGreaterThan(0)

    expect(status).toBe(2)
    expect(output).toContain('--yes')
  })

  it('test --model 不在目录里 ⇒ 退出 2，且一样不发那条消息', async () => {
    const before = gatewayHits.length
    const { status, output } = await runCli(['test', '--model', 'cn:not-in-catalog', '--yes', '--config', fakeConfigPath])
    expect(gatewayHits.slice(before).some(call => call.url.includes('/chat/completions'))).toBe(false)
    expect(status).toBe(2)
    expect(output).toContain('目录里没有模型')
  })
})
