/**
 * 端到端（进程内）装填测试：真 cordis Context + 真 `LlmRuntime` + **真 HTTP 网关替身**
 * + 假 settings 服务，跑完「启动 → 拉 `/v1/models` → 生成 provider 配置 → `mutate`」整条链路。
 *
 * 这一层专门钉住三件单测证明不了的事：
 *  1. 插件在 `apply()` 之后**真的会自己去创建** provider（不是只有函数写好了）；
 *  2. 落进 settings 的那份配置，`api` / `baseURL` / `apiKeyEnv` / 每个模型的
 *     `contextWindow` / `maxTokens` / `input` / `reasoningEfforts` 全部来自网关载荷；
 *  3. provider 已存在时**整条链路一个字节都不写、也不打网关**。
 *
 * settings 服务是替身而不是真的 `dsh-settings`：真的那份会去改 profile 的
 * `cordis.patch.yml`，测试绝不能碰用户的配置文件。替身只记录调用。
 *
 * 单独成文件的原因见 `plugin-load.spec.ts` 顶部注释：cordis 的根服务注册表是
 * 进程级共享的，一个文件只能干净地建一棵树。因此这里只放「provider 缺失 → 创建」
 * 这一条；「provider 已存在 → 不写、也不打网关」由 `provider-config.spec.ts` 的
 * 单元用例覆盖（那里能直接断言 `fetchEntries` **一次都没被调用**，比集成层更严）。
 */

import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { hasKernel, resolveKernel } from '../kernel-resolver.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 网关 `/v1/models` 替身：两条模型，字段覆盖全 / 缺两种情形。 */
const CATALOG = {
  data: [
    {
      id: 'cn:hy4-preview-f',
      object: 'model',
      context_length: 960000,
      max_output_tokens: 64000,
      supports_images: true,
      reasoning_supported_efforts: ['low', 'high', 'max'],
      reasoning_default_effort: 'high',
    },
    { id: 'cn:text-only', object: 'model', context_length: 128000 },
  ],
}

/** 起一个只回 `/v1/models` 的网关替身，返回端口与关闭函数。 */
async function startFakeGateway(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    if (request.url?.endsWith('/models') === true) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(CATALOG))
      return
    }
    response.writeHead(404)
    response.end('{}')
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    close: async () => { await new Promise<void>(resolve => { server.close(() => { resolve() }) }) },
  }
}

/** llm-pi-ai 风格的 volatile 表单。 */
const PROVIDERS_FORM = {
  type: 'object',
  dict: { providers: { type: 'dict', inner: { type: 'object', dict: {} }, meta: {} } },
}

let gateway: { port: number; close: () => Promise<void> } | undefined
afterEach(async () => {
  await gateway?.close()
  gateway = undefined
})

// 需要真实内核才能建 cordis 树：探测不到就跳过，避免别人的 checkout 红一片。
describe.skipIf(!hasKernel())('provider 自动装填（真 cordis + 真 HTTP 替身 + 假 settings）', () => {
  it('provider 缺失时：从 /v1/models 生成并写进 ["providers","workbuddy"]', async () => {
    const cordis = await import(resolveKernel('cordis'))
    const llm = await import(resolveKernel('dsh-llm'))
    const commands = await import(resolveKernel('dsh-commands'))
    const plugin = await import(pathToFileURL(join(projectRoot, 'lib', 'index.js')).href) as unknown as {
      apply(ctx: unknown, config?: unknown): void
    }

    gateway = await startFakeGateway()
    const calls: Array<{ ns: string; ops: unknown[]; revision?: number }> = []
    const ctx = new cordis.Context() as unknown as {
      provide(name: string, value: unknown): void
      llm: { listProviders(): Array<{ id: string }> }
    }
    void new llm.LlmRuntime(ctx as never)
    void new commands.CommandRuntime(ctx as never)
    ctx.provide('subprocess', {
      resolveExecutable: async () => { throw new Error('n/a') },
      terminalEnvironment: async () => ({ platform: 'windows' as const }),
      spawn: () => { throw new Error('n/a') },
      spawnTerminal: async () => { throw new Error('n/a') },
    })
    ctx.provide('settings', {
      describe: () => [{
        ns: 'llm-pi-ai',
        revision: 12,
        schema: PROVIDERS_FORM,
        // 别的 provider 已在，我们要建的 workbuddy 不在。
        value: { providers: { 'opencode-go': { models: [] } } },
      }],
      mutate: async (ns: string, ops: unknown[], revision?: number) => { calls.push({ ns, ops, revision }) },
    })

    plugin.apply(ctx, {
      autoStart: false,
      baseURL: `http://127.0.0.1:${gateway.port}/v1`,
      apiKeyRef: 'WORKBUDDY2API_API_KEY',
    })

    // 装填是 setTimeout(0) 之后跑的异步任务；等它落地。
    for (let i = 0; i < 200 && calls.length === 0; i += 1) {
      await new Promise(resolve => { setTimeout(resolve, 25) })
    }

    expect(calls.length).toBe(1)
    expect(calls[0].ns).toBe('llm-pi-ai')
    expect(calls[0].revision).toBe(12)
    const ops = calls[0].ops as Array<{ op: string; path: string[]; value: Record<string, unknown> }>
    expect(ops.length).toBe(1)
    expect(ops[0].op).toBe('set')
    expect(ops[0].path).toEqual(['providers', 'workbuddy'])
    const value = ops[0].value as {
      apiKeyEnv: string
      api: string
      baseURL: string
      retryPolicy: { mode: string; maxRetries: number }
      models: Array<Record<string, unknown>>
    }
    expect(value.api).toBe('openai-completions')
    expect(value.baseURL).toBe(`http://127.0.0.1:${gateway.port}/v1`)
    expect(value.apiKeyEnv).toBe('WORKBUDDY2API_API_KEY')
    expect(value.retryPolicy).toEqual({ mode: 'normal', maxRetries: 0 })
    // 顺序与网关返回一致，id 保留 realm 前缀（线上要显式寻址 realm）。
    expect(value.models.map(model => model.id)).toEqual(['cn:hy4-preview-f', 'cn:text-only'])
    expect(value.models[0]).toEqual({
      id: 'cn:hy4-preview-f',
      contextWindow: 960000,
      maxTokens: 64000,
      input: ['text', 'image'],
      reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
    })
    // 第二条网关没给 max_output_tokens / supports_images → 不写 maxTokens、input 只有 text。
    expect(value.models[1].maxTokens).toBeUndefined()
    expect(value.models[1].input).toEqual(['text'])

    // 默认路径下自带路由不注册。
    expect(ctx.llm.listProviders().map(provider => provider.id)).not.toContain('workbuddy2api')
  })
})
