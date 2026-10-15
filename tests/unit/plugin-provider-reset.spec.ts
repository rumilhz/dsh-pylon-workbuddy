/**
 * 端到端（进程内）：`/wb2api-provider --rebuild --reset` 走**命令注册**这条真路径 ——
 * 真 cordis 树 + 真 HTTP 网关替身 + 真 profile patch 文件 + 真墓碑文件。
 *
 * 这一层钉住的是「接线」而不是「算法」（算法由 `provider-config.spec.ts` 的
 * `--rebuild --reset` 一组覆盖）：
 *   · 用户敲的 `--reset` 真的被解析成「整份覆盖」，而不是悄悄退化成只增不删；
 *   · 覆盖后的墓碑文件真的被重置成网关目录；
 *   · **不带 `--reset` 时走的仍是原来那条只增不删的路**（CLI 层也一个字不变）。
 *
 * 单独成文件的原因见 `plugin-load.spec.ts` 顶部注释：cordis 的根服务注册表是
 * 进程级共享的，一个文件只能干净地建一棵树。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { hasKernel, resolveKernel } from '../kernel-resolver.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

type CommandResult = { kind: string; text: string }
type Command = { name: string; handler: (input: { rawInput: string }) => Promise<CommandResult> }

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** llm-pi-ai 风格的 volatile 表单（与其它 spec 保持一致）。 */
const PROVIDERS_FORM = {
  type: 'object',
  dict: { providers: { type: 'dict', inner: { type: 'object', dict: {} }, meta: {} } },
}

/** 起一个只回 `/v1/models` 的网关替身（reset 会用它的目录整份覆盖）。 */
async function startFakeGateway(ids: string[]): Promise<string> {
  const server: Server = createServer((request, response) => {
    if (request.url?.endsWith('/models') === true) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        data: ids.map(id => ({ id, object: 'model', context_length: 128000, max_output_tokens: 8192 })),
      }))
      return
    }
    response.writeHead(404)
    response.end('{}')
  })
  cleanups.push(async () => { await new Promise<void>(resolve => { server.close(() => { resolve() }) }) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}/v1`
}

/** patch 文件：`countPatchEntries` 认的是 `- id: xxx` 那几行，条目数不能变少。 */
function writePatch(patchPath: string): void {
  mkdirSync(dirname(patchPath), { recursive: true })
  writeFileSync(patchPath, [
    '- id: llm-pi-ai',
    '  config:',
    '    providers: {}',
    '- id: ui-theme',
    '  config: {}',
    '',
  ].join('\n'), 'utf8')
}

describe.skipIf(!hasKernel())('CLI：/wb2api-provider --rebuild --reset（完全重建的接线）', () => {
  /**
   * 装一次插件，返回命令面。
   *
   * @param models - provider 当前配置里的模型 id（真机上是那 6 个手写的）。
   * @param catalog - 网关目录（真机上是那 48 个）。
   * @param tombstone - 预置的墓碑文件内容（`undefined` = 没有记录）。
   */
  async function mount(options: {
    models: string[]
    catalog: string[]
    tombstone?: string[]
  }): Promise<{ commands: Map<string, Command>; mutated: Array<{ ns: string; ops: unknown[]; rev?: number }>; home: string; baseURL: string }> {
    const cordis = await import(resolveKernel('cordis'))
    const plugin = await import(pathToFileURL(join(projectRoot, 'lib', 'index.js')).href) as unknown as {
      apply(ctx: unknown, config?: unknown): void
    }
    const home = mkdtempSync(join(tmpdir(), 'wb2a-cli-home-'))
    cleanups.push(() => { rmSync(home, { recursive: true, force: true }) })
    const patchPath = join(home, 'profiles', 'test', 'cordis.patch.yml')
    writePatch(patchPath)
    if (options.tombstone !== undefined) {
      mkdirSync(join(home, '.wb2api'), { recursive: true })
      writeFileSync(join(home, '.wb2api', 'state.json'), JSON.stringify({
        version: 1,
        providers: { workbuddy: { lastOffered: options.tombstone } },
      }), 'utf8')
    }
    const baseURL = await startFakeGateway(options.catalog)

    // settings 替身：值放内存，mutate 记下来并**真的改内存**（写后核对要读回它）。
    const value: { providers: Record<string, unknown> } = {
      providers: { workbuddy: { apiKeyEnv: 'X', models: options.models.map(id => ({ id })) } },
    }
    const mutated: Array<{ ns: string; ops: unknown[]; rev?: number }> = []
    const settings = {
      describe: () => [{ ns: 'llm-pi-ai', revision: 9, schema: PROVIDERS_FORM, value }],
      mutate: async (ns: string, ops: unknown[], rev?: number) => {
        mutated.push({ ns, ops, rev })
        for (const op of ops as Array<{ op: string; path: string[]; value: unknown }>) {
          if (op.op === 'set' && op.path.join('.') === 'providers.workbuddy') {
            value.providers['workbuddy'] = op.value
          }
        }
      },
    }

    const commands = new Map<string, Command>()
    const ctx = new cordis.Context() as unknown as {
      provide(name: string, value: unknown): void
      logger: unknown
    }
    ctx.provide('subprocess', {
      resolveExecutable: async () => { throw new Error('n/a') },
      terminalEnvironment: async () => ({ platform: 'windows' as const }),
      spawn: () => { throw new Error('n/a') },
      spawnTerminal: async () => { throw new Error('n/a') },
    })
    ctx.provide('settings', settings)
    ctx.provide('commands', {
      register: (command: Command) => { commands.set(command.name, command) },
    })
    ctx.provide('profileContext', { home, dir: join(home, 'profiles', 'test'), patchPath })

    plugin.apply(ctx, {
      autoStart: false,
      baseURL,
      providerNamespace: 'llm-pi-ai',
      workingDir: join(home, 'work'),
    })
    // 命令是同步注册的；`llm` 服务缺席时插件会停在 PENDING —— 这里显式等一小会，
    // 让「命令没注册」这种失败以断言的形式出现，而不是一句 TypeError。
    for (let i = 0; i < 40 && !commands.has('wb2api-provider'); i += 1) {
      await new Promise(resolve => { setTimeout(resolve, 25) })
    }
    return { commands, mutated, home, baseURL }
  }

  it('★ --rebuild --reset：整份覆盖成网关目录，并把丢掉的 id 报出来 + 墓碑被重置', async () => {
    const { commands, mutated, home } = await mount({
      models: ['cn:hand-1', 'cn:hand-2', 'cn:hand-3'],
      catalog: ['cn:a', 'cn:b', 'cn:c', 'cn:d'],
    })
    const provider = commands.get('wb2api-provider')
    expect(provider, '命令没有注册').toBeDefined()

    const result = await provider!.handler({ rawInput: '--rebuild --reset' })
    expect(result.kind).toBe('success')

    // 写进去的必须**正好是网关目录**（手写的那三个被丢掉）。
    expect(mutated).toHaveLength(1)
    const written = (mutated[0].ops[0] as { value: { models: Array<{ id: string }> } }).value.models.map(model => model.id)
    expect(written).toEqual(['cn:a', 'cn:b', 'cn:c', 'cn:d'])

    // 输出必须点名丢掉的那些 id（0.4.0 的承诺），并说清这是完全重建。
    expect(result.text).toContain('整份覆盖')
    expect(result.text).toContain('原来 3 个 → 现在 4 个')
    expect(result.text).toContain('cn:hand-1')
    expect(result.text).toContain('cn:hand-2')
    expect(result.text).toContain('cn:hand-3')

    // 墓碑被重置为网关目录（不是保留旧并集）。
    const state = JSON.parse(readFileSync(join(home, '.wb2api', 'state.json'), 'utf8')) as {
      providers: Record<string, { lastOffered: string[] }>
    }
    expect(state.providers['workbuddy']?.lastOffered).toEqual(['cn:a', 'cn:b', 'cn:c', 'cn:d'])
  })

  it('🔴 不带 --reset：走的仍是**只增不删**那条路（CLI 层默认行为一个字不变）', async () => {
    const { commands, mutated, home } = await mount({
      models: ['cn:kept'],
      catalog: ['cn:kept', 'cn:new'],
      // 墓碑里已经有 cn:before（用户删掉的）—— 只增不删的铁律：它不许复活。
      tombstone: ['cn:kept', 'cn:before'],
    })
    const result = await (commands.get('wb2api-provider'))!.handler({ rawInput: '--rebuild' })
    expect(result.kind).toBe('success')

    const written = (mutated[0].ops[0] as { value: { models: Array<{ id: string }> } }).value.models.map(model => model.id)
    // 保留原样的 cn:kept + 只补网关新增的 cn:new；墓碑里的 cn:before 不回来。
    expect(written).toEqual(['cn:kept', 'cn:new'])
    expect(result.text).toContain('只增不删')
    expect(result.text).toContain('保留 1 个')
    expect(result.text).not.toContain('整份覆盖')

    const state = JSON.parse(readFileSync(join(home, '.wb2api', 'state.json'), 'utf8')) as {
      providers: Record<string, { lastOffered: string[] }>
    }
    // 墓碑 = 上一轮 ∪ 保留的 ∪ 新增的（cn:before 不能被抹掉）。
    expect(state.providers['workbuddy']?.lastOffered).toEqual(['cn:kept', 'cn:before', 'cn:new'])
  })

  it('🔴 既没有墓碑记录、也没敲 --reset：一个都不加，并把出口指明白', async () => {
    const { commands, mutated, home } = await mount({
      models: ['cn:hand-1'],
      catalog: ['cn:a', 'cn:b'],
    })
    const result = await (commands.get('wb2api-provider'))!.handler({ rawInput: '--rebuild' })
    expect(result.kind).toBe('success')
    // 这正是「第一次用」的死角：不写 patch（没有退路的复活风险），但必须说清为什么 + 该用哪个开关。
    expect(mutated).toHaveLength(0)
    expect(result.text).toContain('一个都不加')
    expect(result.text).toContain('--rebuild --reset')
    // 它仍然把网关当前目录立成基线（记忆从这一刻开始）。
    const state = JSON.parse(readFileSync(join(home, '.wb2api', 'state.json'), 'utf8')) as {
      providers: Record<string, { lastOffered: string[] }>
    }
    expect(state.providers['workbuddy']?.lastOffered).toEqual(['cn:hand-1', 'cn:a', 'cn:b'])
    expect(existsSync(join(home, '.wb2api', 'state.json'))).toBe(true)
  })

  it('完全重建也过安全网：写前备份落到 profile 之外', async () => {
    const { commands, home } = await mount({
      models: ['cn:hand-1'],
      catalog: ['cn:a'],
    })
    await (commands.get('wb2api-provider'))!.handler({ rawInput: '--rebuild --reset' })
    const backupRoot = join(home, 'wb2api-write-backups')
    expect(existsSync(backupRoot)).toBe(true)
  })
})
