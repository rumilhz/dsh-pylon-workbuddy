/**
 * 插件装载集成测试：把**构建产物**装进一个真实的 cordis Context，
 * 用真实的 `@deepseek-ai/dsh-llm` 运行时跑一遍默认路径。
 *
 * 这一层补上了单元测试够不到的地方：
 *  - 默认**不**注册自带路由（`registerConfigurableProviders` / `registerAdapter`
 *    都不该被调用）—— 那正是「设置 → 模型」里第二个不可编辑行的来源；
 *  - `ctx.commands.register()` 的命令清单（含新的 `/wb2api-provider`）；
 *  - `Config` schema 能否被 `toJSON()`（settings 描述条目的硬要求）；
 *  - `Config` **不含 volatile 字段** —— 一旦含了，本插件的条目就会在
 *    「设置 → 模型」里多出一行，本文件最后一条用例专门钉这件事。
 *
 * **为什么整个文件共用同一个 Context**：cordis 的根服务注册表是**进程级共享**的，
 * 第二次 `ctx.provide('llm', ...)` 会报 `service "llm" has been registered at <root>`；
 * 而 `ctx.isolate(name, label)` 对**相同 label 会合并作用域**，也救不了同一文件内的
 * 多次建树。vitest 默认按文件隔离模块，因此「一个文件一个 Context」是唯一干净的切法；
 * 需要另建一棵树的路径各自单独成文件（`plugin-degrade` / `plugin-route-conflict` /
 * `plugin-legacy-provider` / `plugin-provider-seed`）。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { hasKernel, resolveKernel } from '../kernel-resolver.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 造一个最小的 subprocess 替身（本测试不需要真进程）。 */
function fakeSubprocess() {
  return {
    resolveExecutable: async (command: string) => { throw new Error(`not found: ${command}`) },
    terminalEnvironment: async () => ({ platform: 'windows' as const }),
    spawn: () => { throw new Error('spawn not expected in this test') },
    spawnTerminal: async () => { throw new Error('unused') },
  }
}

interface PluginExports {
  name: string
  inject: string[]
  Config: { toJSON(): unknown }
  apply(ctx: unknown, config?: unknown): void
}

let cordis: typeof import('@deepseek-ai/cordis')
let llm: typeof import('@deepseek-ai/dsh-llm')
let plugin: PluginExports
let ctx: {
  provide(name: string, value: unknown): void
  llm: {
    listProviders(): Array<{ id: string; name: string }>
    listConfigurableProviders(): Array<{ provider: string; settingsNs: string }>
    registerAdapter(providers: string[], adapter: unknown): unknown
  }
  commands: { list(agent: unknown): Array<{ name: string }> }
  stop(): Promise<void>
}

// 需要真实内核才能建 cordis 树：探测不到就跳过，避免别人的 checkout 红一片。
describe.skipIf(!hasKernel())('插件装载（真实 cordis + dsh-llm）', () => {
  beforeAll(async () => {
    cordis = await import(resolveKernel('cordis'))
    llm = await import(resolveKernel('dsh-llm'))
    const commands = await import(resolveKernel('dsh-commands'))
    plugin = await import(pathToFileURL(join(projectRoot, 'lib', 'index.js')).href) as unknown as PluginExports

    ctx = new cordis.Context() as unknown as typeof ctx
    // 服务注册表是**每个根 Context 独立**的，所以一个文件建一棵树即可。
    //
    // 注意：`LlmRuntime` / `CommandRuntime` 都是 cordis `Service` 子类，**构造时就以
    // 静态 `provide` 名把自己注册进传入的 ctx**。因此构造之后**不能**再对同一名字调
    // `ctx.provide()` —— 那会报 `service "X" has been registered at <root>`。
    // 只有非 Service 的替身（subprocess）才需要手工 provide。
    void new llm.LlmRuntime(ctx as never)
    void new commands.CommandRuntime(ctx as never)
    ctx.provide('subprocess', fakeSubprocess())
    // 刻意**不**提供 settings：默认路径下没有 settings 只应降级，不该阻止加载。

    // autoStart: false —— 测试不拉起真实进程；端口用一个必然空闲的高端口。
    plugin.apply(ctx, { autoStart: false, baseURL: 'http://127.0.0.1:59993/v1' })
  })

  it('插件导出面符合 dsh 插件契约', () => {
    expect(plugin.name).toBe('workbuddy2api')
    expect(plugin.inject).toEqual(['llm', 'subprocess', 'commands'])
    expect(typeof plugin.apply).toBe('function')
  })

  it('Config schema 可被 toJSON()（settings 描述条目的硬要求）', () => {
    // 传裸函数会让 settings.describe() 抛
    // `registration.schema.toJSON is not a function`，进而拖垮整个设置页。
    expect(typeof plugin.Config.toJSON).toBe('function')
    const json = plugin.Config.toJSON()
    expect(json).toBeTypeOf('object')
    expect(Object.keys(json as object).length).toBeGreaterThan(0)
  })

  it('Config 不含 volatile 字段 —— 否则供应商列表会多出本插件这一行', () => {
    // dsh-settings 只暴露带 volatile 字段的条目；本插件一旦被暴露，模型页就会渲染
    // 第二个（不可编辑的）provider 行，正是这次改动要消除的东西。
    const json = plugin.Config.toJSON() as { dict?: Record<string, { meta?: { volatile?: unknown } }> }
    const volatileFields = Object.entries(json.dict ?? {})
      .filter(([, node]) => node.meta?.volatile !== undefined)
      .map(([key]) => key)
    expect(volatileFields).toEqual([])
  })

  it('默认【不】注册自带路由（workbuddy2api 不在 provider 清单里）', () => {
    expect(ctx.llm.listProviders().map(provider => provider.id)).not.toContain('workbuddy2api')
  })

  it('默认【不】声明可配置 provider 目录（模型页不会有第二行）', () => {
    expect(ctx.llm.listConfigurableProviders().map(item => item.provider)).not.toContain('workbuddy2api')
  })

  it('五个管理命令都注册成功（含只读的 /wb2api-provider）', () => {
    const listed = ctx.commands.list({} as never).map(descriptor => descriptor.name)
    for (const expected of ['wb2api-status', 'wb2api-start', 'wb2api-restart', 'wb2api-login', 'wb2api-provider']) {
      expect(listed).toContain(expected)
    }
  })

  it('真实基类提供适配器覆盖的全部方法（回退路径仍要能跑）', () => {
    for (const method of ['providerInfo', 'listModels', 'resolveModel', 'prepareCall']) {
      expect(typeof (llm.LlmAdapter.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
    }
  })
})
