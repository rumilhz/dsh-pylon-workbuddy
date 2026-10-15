/**
 * 端到端（进程内）：卡片上的「签到」按钮走完整条链路 —— 真 cordis 树 + 真 HTTP 路由
 * + 真 `boot.log`，唯一的替身是**上游**（global fetch）。
 *
 * 这一层专门钉住 2026-10-15 真机上暴露的两件事，它们在单测里各自都成立、却可能
 * **没有接起来**：
 *
 *  ① 上游回「今天已签到」（`HTTP 400` + `code 10001`）时，卡片那一侧拿到的是
 *     `ok: true`（幂等成功）而不是 `ok: false`；
 *  ② `boot.log` 里那一行**带上 `status` 与 `detail`** —— 老代码只有
 *     `attempted/ok`，于是「今天已签到」与「上游真的拒了」在这份日志里长得一模一样，
 *     把一个本该 30 秒定位的问题变成了一次专门的探针。
 *
 * 单独成文件的原因见 `plugin-load.spec.ts` 顶部注释：cordis 的根服务注册表是
 * 进程级共享的，一个文件只能干净地建一棵树。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { hasKernel, resolveKernel } from '../kernel-resolver.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 本机路由请求要走真 fetch —— 只有上游那一个 URL 被替身接管。 */
const realFetch = globalThis.fetch

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** 造一份「启用中的 CN 账号」凭证文件（网关 glob 是 workbuddy*.json）。 */
function writeAuthFile(authDir: string, uid: string): void {
  mkdirSync(authDir, { recursive: true })
  writeFileSync(join(authDir, `workbuddy-${uid}.json`), JSON.stringify({
    account: { uid, enterpriseId: 'ent-1', nickname: '测试账号' },
    auth: {
      accessToken: 'upstream-token',
      refreshToken: 'r',
      expiresAt: Math.floor(Date.now() / 1000) + 7200,
      domain: 'copilot.tencent.com',
      realm: 'cn',
    },
  }, null, 1), 'utf8')
}

/** 起一个把请求原样交给插件的宿主路由 handler 的真 http 服务器。 */
async function serve(handler: (req: unknown, res: unknown) => Promise<void>): Promise<string> {
  const server: Server = createServer((request, response) => { void handler(request, response) })
  cleanups.push(async () => { await new Promise<void>(resolve => { server.close(() => { resolve() }) }) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

describe.skipIf(!hasKernel())('卡片签到：三态 + boot.log（真 cordis + 真路由 + 真轨迹文件）', () => {
  it('上游说「今天已签到」⇒ 回执是 ok:true/status=already，且 boot.log 带着 detail', async () => {
    const cordis = await import(resolveKernel('cordis'))
    const llm = await import(resolveKernel('dsh-llm'))
    const commands = await import(resolveKernel('dsh-commands'))
    const plugin = await import(pathToFileURL(join(projectRoot, 'lib', 'index.js')).href) as unknown as {
      apply(ctx: unknown, config?: unknown): void
    }

    // 临时 home（boot.log 落点）与临时网关工作目录（auths 落点）。
    const home = mkdtempSync(join(tmpdir(), 'wb2a-home-'))
    const working = mkdtempSync(join(tmpdir(), 'wb2a-work-'))
    cleanups.push(() => { rmSync(home, { recursive: true, force: true }) })
    cleanups.push(() => { rmSync(working, { recursive: true, force: true }) })
    writeAuthFile(join(working, 'auths'), 'oneid_trace_test')
    const previousHome = process.env['DSH_HOME']
    process.env['DSH_HOME'] = home
    cleanups.push(() => {
      if (previousHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previousHome
    })

    // ── 上游替身：真机实录那一份应答 ─────────────────────────────────────────
    const upstreamCalls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/daily-checkin')) {
        upstreamCalls.push(url)
        return new Response(JSON.stringify({ code: 10001, msg: '今天已签到，请明天再来', requestId: 'x' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      return await realFetch(input as never, init)
    }) as typeof fetch
    cleanups.push(() => { globalThis.fetch = realFetch })

    // ── 真 cordis 树：只提供「路由」那一半所需的三个服务 ──────────────────────
    const ctx = new cordis.Context() as unknown as {
      provide(name: string, value: unknown): void
      logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
    }
    void new llm.LlmRuntime(ctx as never)
    void new commands.CommandRuntime(ctx as never)
    ctx.provide('subprocess', {
      resolveExecutable: async () => { throw new Error('n/a') },
      terminalEnvironment: async () => ({ platform: 'windows' as const }),
      spawn: () => { throw new Error('n/a') },
      spawnTerminal: async () => { throw new Error('n/a') },
    })
    // 栅栏：放行（真机上它来自 dsh-client-connection）。
    ctx.provide('connection', { requestRejection: () => undefined })
    const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> }> = []
    ctx.provide('webServer', {
      register: (route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      },
    })
    ctx.provide('profileContext', { home })

    plugin.apply(ctx, {
      autoStart: false,
      workingDir: working,
      baseURL: 'http://127.0.0.1:59987/v1',
    })

    // 路由是 `ctx.inject(['connection','webServer'])` 延迟注册的 —— 等它落地。
    for (let i = 0; i < 200 && routes.length === 0; i += 1) {
      await new Promise(resolve => { setTimeout(resolve, 25) })
    }
    const action = routes.find(route => route.path === '/wb2api')
    expect(action, '设置卡片的路由没有注册').toBeDefined()

    const base = await serve(action!.handler)
    const response = await realFetch(`${base}/wb2api/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'checkin' }),
    })
    const body = await response.json() as Record<string, unknown>

    // ① 卡片那一侧：HTTP 400 的上游应答被正确地判成**幂等成功**。
    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0]).toContain('https://www.codebuddy.cn/v2/billing/meter/daily-checkin')
    expect(body).toMatchObject({ ok: true, attempted: true, status: 'already', already: true })
    expect(String(body.detail)).toContain('幂等成功')

    // ② boot.log 里那一行必须能独立定位问题：三态 + detail 都在。
    const log = readFileSync(join(home, '.wb2api', 'boot.log'), 'utf8')
    const line = log.split('\n').find(row => row.includes('api: checkin'))
    expect(line, `boot.log 里没有 checkin 那一行：\n${log}`).toBeDefined()
    expect(line).toContain('realm=cn')
    expect(line).toContain('attempted=true')
    expect(line).toContain('ok=true')
    expect(line).toContain('status=already')
    expect(line).toContain('detail=')
    expect(line).toContain('今天已签到，请明天再来')
    // 幂等成功这一态**不能**在日志里长得像失败（老代码那一行只有 ok=false）。
    expect(line).not.toContain('ok=false')
  })
})
