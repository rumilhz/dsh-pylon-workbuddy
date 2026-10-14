/**
 * 回退路径（`registerOwnProvider: true`）测试：确认 0.3.x 的自带路由仍能注册，
 * 也就是这次改动**可逆**。
 *
 * 单独成文件的原因见 `plugin-load.spec.ts` 顶部注释：cordis 的根服务注册表是
 * 进程级共享的，一个文件只能干净地建一棵树。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { hasKernel, resolveKernel } from '../kernel-resolver.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// 需要真实内核才能建 cordis 树：探测不到就跳过，避免别人的 checkout 红一片。
describe.skipIf(!hasKernel())('回退路径 registerOwnProvider=true', () => {
  let ctx: {
    llm: {
      listProviders(): Array<{ id: string; name: string }>
      listConfigurableProviders(): Array<{ provider: string; settingsNs: string }>
      registerAdapter(providers: string[], adapter: unknown): unknown
    }
  }
  let llm: typeof import('@deepseek-ai/dsh-llm')

  beforeAll(async () => {
    const cordis = await import(resolveKernel('cordis'))
    llm = await import(resolveKernel('dsh-llm'))
    const commands = await import(resolveKernel('dsh-commands'))
    const plugin = await import(pathToFileURL(join(projectRoot, 'lib', 'index.js')).href) as unknown as {
      apply(ctx: unknown, config?: unknown): void
    }

    ctx = new cordis.Context() as unknown as typeof ctx
    void new llm.LlmRuntime(ctx as never)
    void new commands.CommandRuntime(ctx as never)
    ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('subprocess', {
      resolveExecutable: async () => { throw new Error('n/a') },
      terminalEnvironment: async () => ({ platform: 'windows' as const }),
      spawn: () => { throw new Error('n/a') },
      spawnTerminal: async () => { throw new Error('n/a') },
    })

    plugin.apply(ctx, {
      autoStart: false,
      registerOwnProvider: true,
      baseURL: 'http://127.0.0.1:59991/v1',
    })
  })

  it('自带路由按旧行为注册进真实 LlmRuntime', () => {
    const providers = ctx.llm.listProviders()
    expect(providers.map(provider => provider.id)).toContain('workbuddy2api')
    // 契约要求 name 非空，且 providerInfo().id === 注册的路由名。
    expect(providers.find(provider => provider.id === 'workbuddy2api')?.name.length).toBeGreaterThan(0)
  })

  it('可配置 provider 目录里也有该路由（旧行为：模型设置页据此展示）', () => {
    const entry = ctx.llm.listConfigurableProviders().find(item => item.provider === 'workbuddy2api')
    expect(entry).toBeDefined()
    expect(entry?.settingsNs).toBe('llm-workbuddy2api')
  })

  it('同一路由重复注册仍被拒（迁移冲突的可检出行径）', async () => {
    // 外部配置里残留旧 provider 时，回退路径启动就会走到这条路径。
    // 真实错误：code = `DUPLICATE_ADAPTER`，人类可读消息为
    // `an adapter for provider "workbuddy2api" is already registered`
    // —— 消息里**不含** code 字样，所以迁移排障要认 code 或这句英文。
    class Dummy extends llm.LlmAdapter {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<never> { throw new Error('unused') }
    }
    let caught: unknown
    try {
      ctx.llm.registerAdapter(['workbuddy2api'], new Dummy())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('DUPLICATE_ADAPTER')
    expect((caught as Error).message).toMatch(/already registered/)
  })
})
