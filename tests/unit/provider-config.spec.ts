/**
 * 生成「可编辑 provider」的逻辑：namespace 探测、存在性判定、块生成、只读差异、
 * 以及**存在即不改写**这条核心不变量。
 *
 * 这一层刻意不建 cordis 树、不连真网关：`seedEditableProvider` 的依赖全是注入的，
 * 因此「已存在时连目录都不拉」这种最容易悄悄退化的行为可以直接断言。
 */

import { describe, expect, it, vi } from 'vitest'
import { readCatalogEntries, type GatewayCatalogEntry } from '../../src/models.js'
import {
  buildProviderProfile,
  diffProviderModels,
  findProviderNamespace,
  GATEWAY_WIRE_API,
  providerExists,
  renderProviderNotes,
  renderProviderProfileYaml,
  seedEditableProvider,
  THINKING_LEVELS,
  type ProviderProfile,
  type SettingsDescriptor,
  type SettingsServiceLike,
  type WriteGuard,
} from '../../src/provider-config.js'

/** 造一份 llm-pi-ai 风格的 volatile 表单 schema。 */
function providersForm(extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    dict: {
      providers: { type: 'dict', inner: { type: 'object', dict: {} }, meta: {} },
      ...extra,
    },
  }
}

/** 造一个 settings 替身。 */
function fakeSettings(descriptors: SettingsDescriptor[], onMutate?: (ns: string, ops: unknown[], rev?: number) => void): SettingsServiceLike {
  return {
    describe: () => descriptors,
    mutate: async (ns, ops, revision) => { onMutate?.(ns, ops as unknown[], revision) },
  }
}

/**
 * 造一个默认「一切正常」的写路径安全网替身。
 *
 * 默认通过是刻意的：绝大多数用例要验的是**别的东西**（revision 回传、YAML 形状、
 * 重试节奏），不该被安全网干扰；而安全网自己的行为由下面那组专门的用例覆盖。
 */
function fakeGuard(overrides: Partial<WriteGuard> = {}): WriteGuard {
  return {
    snapshot: async () => ({
      backupPath: 'C:\\bak\\cordis.patch.yml.before-write-20261012-000000-34entries.bak',
      entryCount: 34,
      bytes: 63570,
    }),
    verify: async () => ({ ok: true }),
    rollback: async () => {},
    ...overrides,
  }
}

const entry = (id: string, overrides: Partial<GatewayCatalogEntry> = {}): GatewayCatalogEntry => ({
  id,
  reasoningEfforts: [],
  ...overrides,
})

describe('findProviderNamespace', () => {
  it('挑出根级 providers 是 dict 的那一项，并带上候选清单', () => {
    const found = findProviderNamespace(fakeSettings([
      { ns: 'ui-theme', schema: { type: 'object', dict: { accent: { type: 'string' } } }, value: {} },
      { ns: 'llm-pi-ai', schema: providersForm(), value: { providers: { workbuddy: { models: [1, 2] } } } },
    ]), '')
    expect(found?.ns).toBe('llm-pi-ai')
    expect(found?.candidates).toEqual(['llm-pi-ai'])
    expect(Object.keys(found?.providers ?? {})).toEqual(['workbuddy'])
  })

  it('条目 id 不是字面量 llm-pi-ai 时照样能找到（dev 构建是 include:llm-pi-ai）', () => {
    const found = findProviderNamespace(fakeSettings([
      { ns: 'include:llm-pi-ai', schema: providersForm(), value: {} },
    ]), '')
    expect(found?.ns).toBe('include:llm-pi-ai')
  })

  it('显式指定的 namespace 优先于字面量匹配', () => {
    const found = findProviderNamespace(fakeSettings([
      { ns: 'llm-pi-ai', schema: providersForm(), value: {} },
      { ns: 'my-pi-ai', schema: providersForm(), value: {} },
    ]), 'my-pi-ai')
    expect(found?.ns).toBe('my-pi-ai')
    expect(found?.candidates).toEqual(['llm-pi-ai', 'my-pi-ai'])
  })

  it('多个候选且无指定时按字典序取第一个（不靠 describe 的返回顺序）', () => {
    const found = findProviderNamespace(fakeSettings([
      { ns: 'zzz-llm', schema: providersForm(), value: {} },
      { ns: 'aaa-llm', schema: providersForm(), value: {} },
    ]), '')
    expect(found?.ns).toBe('aaa-llm')
  })

  it('providers 是数组/字符串的条目不算（只认 dict）', () => {
    expect(findProviderNamespace(fakeSettings([
      { ns: 'a', schema: { type: 'object', dict: { providers: { type: 'array' } } }, value: {} },
      { ns: 'b', schema: { type: 'object', dict: { providers: { type: 'string' } } }, value: {} },
    ]), '')).toBeUndefined()
  })

  it('settings 缺失、没有 describe、或 describe 抛错时返回 undefined（降级不抛）', () => {
    expect(findProviderNamespace(undefined, '')).toBeUndefined()
    expect(findProviderNamespace({}, '')).toBeUndefined()
    expect(findProviderNamespace({ describe: () => { throw new Error('boom') } }, '')).toBeUndefined()
  })

  it('providers 三层（base / user / value）合并后再判定存在性', () => {
    const found = findProviderNamespace(fakeSettings([
      {
        ns: 'llm-pi-ai',
        schema: providersForm(),
        base: { providers: { inherited: {} } },
        user: { providers: { handwritten: {} } },
        value: { providers: { live: {} } },
      },
    ]), '')
    expect(found).toBeDefined()
    expect(Object.keys(found?.providers ?? {}).sort()).toEqual(['handwritten', 'inherited', 'live'])
  })
})

describe('providerExists', () => {
  const namespace = { ns: 'llm-pi-ai', revision: 1, providers: { workbuddy: { models: [] } }, candidates: ['llm-pi-ai'] }

  it('键存在即为真', () => {
    expect(providerExists(namespace, 'workbuddy')).toBe(true)
    expect(providerExists(namespace, 'nope')).toBe(false)
  })

  it('键存在但值为 undefined 时视为不存在（留着空位不算已配置）', () => {
    expect(providerExists({ ...namespace, providers: { ghost: undefined } }, 'ghost')).toBe(false)
  })

  it('非法字符的键不会因为原型链而误判', () => {
    expect(providerExists(namespace, 'toString')).toBe(false)
  })
})

describe('readCatalogEntries', () => {
  it('保序、保留 realm 前缀、缺失字段留 undefined', () => {
    const entries = readCatalogEntries({
      data: [
        { id: 'cn:full', context_length: 960000, max_output_tokens: 64000, supports_images: true, reasoning_supported_efforts: ['low', 'high'], reasoning_default_effort: 'high' },
        { id: 'cn:sparse' },
        { id: 'global:g', context_length: 128000 },
      ],
    })
    expect(entries.map(item => item.id)).toEqual(['cn:full', 'cn:sparse', 'global:g'])
    expect(entries[0]).toMatchObject({ contextLength: 960000, maxOutputTokens: 64000, supportsImages: true, reasoningEfforts: ['low', 'high'], reasoningDefaultEffort: 'high' })
    expect(entries[1].contextLength).toBeUndefined()
    expect(entries[1].maxOutputTokens).toBeUndefined()
    expect(entries[1].supportsImages).toBeUndefined()
  })

  it('非正数/非数的 context_length 视为「网关没说」，不兜底成 1M', () => {
    const entries = readCatalogEntries({ data: [{ id: 'a', context_length: 0 }, { id: 'b', context_length: -5 }, { id: 'c', context_length: 'big' }] })
    expect(entries.map(item => item.contextLength)).toEqual([undefined, undefined, undefined])
  })

  it('集合外的默认档被丢弃（不能让选择器显示一个不支持的档位）', () => {
    const entries = readCatalogEntries({ data: [{ id: 'a', reasoning_supported_efforts: ['low'], reasoning_default_effort: 'max' }] })
    expect(entries[0].reasoningEfforts).toEqual(['low'])
    expect(entries[0].reasoningDefaultEffort).toBeUndefined()
  })

  it('无 id / 空 id / 非对象条目被跳过，data 不是数组时给空数组', () => {
    expect(readCatalogEntries({ data: [{ context_length: 1 }, { id: '' }, null, 42, { id: 'ok' }] }).map(item => item.id)).toEqual(['ok'])
    expect(readCatalogEntries({})).toEqual([])
    expect(readCatalogEntries(undefined)).toEqual([])
  })

  it('不去重（配置生成要能看见网关名单里的重复项）', () => {
    expect(readCatalogEntries({ data: [{ id: 'dup' }, { id: 'dup' }] }).length).toBe(2)
  })
})

describe('buildProviderProfile', () => {
  const options = { apiKeyEnv: 'WORKBUDDY2API_API_KEY', baseURL: 'http://127.0.0.1:7863/v1' }

  it('六个字段全部来自网关元数据，且 limit 显式写出', () => {
    const { profile } = buildProviderProfile([
      entry('cn:hy4-preview-f', { contextLength: 960000, maxOutputTokens: 64000, supportsImages: true }),
    ], options)
    expect(profile.api).toBe(GATEWAY_WIRE_API)
    expect(profile.baseURL).toBe('http://127.0.0.1:7863/v1')
    expect(profile.apiKeyEnv).toBe('WORKBUDDY2API_API_KEY')
    expect(profile.models[0]).toEqual({
      id: 'cn:hy4-preview-f',
      contextWindow: 960000,
      maxTokens: 64000,
      input: ['text', 'image'],
    })
  })

  it('contextWindow 缺失时【不写】该字段，并把它记进 notes（不能让它退到 262144 还不知情）', () => {
    const { profile, notes } = buildProviderProfile([entry('cn:x')], options)
    expect(profile.models[0].contextWindow).toBeUndefined()
    expect(profile.models[0].maxTokens).toBeUndefined()
    expect(notes).toEqual([{ id: 'cn:x', absent: ['contextWindow', 'maxTokens'], droppedEfforts: [] }])
    expect(renderProviderNotes(notes)[0]).toContain('262144')
  })

  it('supports_images 缺席即仅文本（显式否定，不是 unknown）', () => {
    const { profile } = buildProviderProfile([entry('a'), entry('b', { supportsImages: true })], options)
    expect(profile.models[0].input).toEqual(['text'])
    expect(profile.models[1].input).toEqual(['text', 'image'])
  })

  it('档位做恒等映射 —— 与本仓库适配器发的 reasoning_effort 同一个值', () => {
    const { profile } = buildProviderProfile([entry('a', { reasoningEfforts: ['low', 'high', 'max'] })], options)
    expect(profile.models[0].reasoningEfforts).toEqual({ low: 'low', high: 'high', max: 'max' })
  })

  it('pi-ai 不认的档位被丢弃并记进 notes（否则整次写入会因 schema 校验失败）', () => {
    const { profile, notes } = buildProviderProfile([entry('a', { reasoningEfforts: ['low', 'turbo'] })], options)
    expect(profile.models[0].reasoningEfforts).toEqual({ low: 'low' })
    expect(notes[0].droppedEfforts).toEqual(['turbo'])
  })

  it('全部档位都不认时不写 reasoningEfforts（空字典会被 pi-ai 判为非法）', () => {
    const { profile } = buildProviderProfile([entry('a', { reasoningEfforts: ['turbo'] })], options)
    expect(profile.models[0].reasoningEfforts).toBeUndefined()
  })

  it('重复 id 折叠成一条并说明（pi-ai 会以 "lists model ... more than once" 拒绝整份配置）', () => {
    const { profile, notes } = buildProviderProfile([entry('dup'), entry('dup')], options)
    expect(profile.models.length).toBe(1)
    expect(notes[0].duplicateOf).toBeDefined()
  })

  it('展示名只在网关给了非空字符串时才写', () => {
    const { profile } = buildProviderProfile([entry('a', { name: 'Hy4 Preview' }), entry('b')], options)
    expect(profile.models[0].name).toBe('Hy4 Preview')
    expect(profile.models[1].name).toBeUndefined()
  })

  it('THINKING_LEVELS 与 pi-ai 的枚举一致', () => {
    expect([...THINKING_LEVELS]).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('renderProviderProfileYaml', () => {
  it('渲染出可粘贴的两层缩进，含冒号的 id 自动加引号', () => {
    const { profile } = buildProviderProfile([
      entry('cn:hy4-preview-f', { contextLength: 960000, maxOutputTokens: 64000, supportsImages: true, reasoningEfforts: ['high'] }),
    ], { apiKeyEnv: 'WORKBUDDY2API_API_KEY', baseURL: 'http://127.0.0.1:7863/v1' })
    expect(renderProviderProfileYaml('workbuddy', profile)).toBe(
      'workbuddy:\n'
      + '  apiKeyEnv: WORKBUDDY2API_API_KEY\n'
      + '  api: openai-completions\n'
      + '  baseURL: "http://127.0.0.1:7863/v1"\n'
      + '  retryPolicy:\n'
      + '    mode: normal\n'
      + '    maxRetries: 0\n'
      + '  models:\n'
      + '    - id: "cn:hy4-preview-f"\n'
      + '      contextWindow: 960000\n'
      + '      maxTokens: 64000\n'
      + '      input:\n'
      + '        - text\n'
      + '        - image\n'
      + '      reasoningEfforts:\n'
      + '        high: high\n',
    )
  })

  it('缺字段的模型不会渲染出该键（不留空值）', () => {
    const { profile } = buildProviderProfile([entry('cn:x')], { apiKeyEnv: 'K', baseURL: 'http://h/v1' })
    const yaml = renderProviderProfileYaml('workbuddy', profile)
    expect(yaml).not.toContain('contextWindow')
    expect(yaml).not.toContain('maxTokens')
    expect(yaml).not.toContain('reasoningEfforts')
  })

  it('YAML 保留字与空串被引起来，不会变成布尔/null', () => {
    const profile: ProviderProfile = {
      apiKeyEnv: 'no',
      api: 'openai-completions',
      baseURL: 'http://h/v1',
      retryPolicy: { mode: 'normal', maxRetries: 0 },
      models: [{ id: 'on', input: ['text'], name: '' }],
    }
    const yaml = renderProviderProfileYaml('workbuddy', profile)
    expect(yaml).toContain('apiKeyEnv: "no"')
    expect(yaml).toContain('name: ""')
    expect(yaml).toContain('- id: "on"')
  })
})

describe('diffProviderModels', () => {
  const profile: ProviderProfile = {
    apiKeyEnv: 'K',
    api: 'openai-completions',
    baseURL: 'http://h/v1',
    retryPolicy: { mode: 'normal', maxRetries: 0 },
    models: [
      { id: 'keep', contextWindow: 100, maxTokens: 10, input: ['text'] },
      { id: 'gone', contextWindow: 200, maxTokens: 20, input: ['text'] },
      { id: 'moved', contextWindow: 300, maxTokens: 30, input: ['text'] },
    ],
  }

  it('分出「网关新增」「网关下架」「数值漂移」三组', () => {
    const diff = diffProviderModels(profile, [
      entry('keep', { contextLength: 100, maxOutputTokens: 10 }),
      entry('moved', { contextLength: 400, maxOutputTokens: 30 }),
      entry('brand-new', { contextLength: 500 }),
    ])
    expect(diff.missingFromProfile).toEqual(['brand-new'])
    expect(diff.unknownToGateway).toEqual(['gone'])
    expect(diff.drifted).toEqual([{ id: 'moved', field: 'contextWindow', configured: 300, gateway: 400 }])
  })

  it('网关没说数值时不报漂移（不能把「未知」当成「不一致」）', () => {
    expect(diffProviderModels(profile, [entry('keep'), entry('gone'), entry('moved')]).drifted).toEqual([])
  })
})

describe('seedEditableProvider', () => {
  const baseDeps = {
    providerName: 'workbuddy',
    preferredNamespace: '',
    apiKeyEnv: 'WORKBUDDY2API_API_KEY',
    baseURL: 'http://127.0.0.1:7863/v1',
    sleep: async () => {},
  }

  it('provider 已存在 → 什么都不做，且【不拉目录】', async () => {
    const fetchEntries = vi.fn(async () => [entry('cn:x', { contextLength: 1, maxOutputTokens: 1 })])
    const mutate = vi.fn(async () => {})
    const outcome = await seedEditableProvider({
      ...baseDeps,
      settings: {
        describe: () => [{
          ns: 'llm-pi-ai',
          revision: 3,
          schema: providersForm(),
          value: { providers: { workbuddy: { models: [{ id: 'a' }, { id: 'b' }] } } },
        }],
        mutate,
      },
      fetchEntries,
    })
    expect(outcome).toEqual({ kind: 'present', ns: 'llm-pi-ai', modelCount: 2 })
    expect(fetchEntries).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('provider 缺失 → 按目录生成并写进 ["providers", name]，回传描述时的 revision', async () => {
    const calls: Array<{ ns: string; ops: unknown[]; rev?: number }> = []
    const outcome = await seedEditableProvider({
      ...baseDeps,
      settings: fakeSettings(
        [{ ns: 'llm-pi-ai', revision: 7, schema: providersForm(), value: { providers: { other: {} } } }],
        (ns, ops, rev) => { calls.push({ ns, ops, rev }) },
      ),
      fetchEntries: async () => [entry('cn:new', { contextLength: 1000, maxOutputTokens: 100, supportsImages: true, reasoningEfforts: ['high'] })],
      guard: fakeGuard(),
    })
    expect(outcome.kind).toBe('created')
    expect(calls.length).toBe(1)
    expect(calls[0].ns).toBe('llm-pi-ai')
    expect(calls[0].rev).toBe(7)
    expect(calls[0].ops).toEqual([{
      op: 'set',
      path: ['providers', 'workbuddy'],
      value: {
        apiKeyEnv: 'WORKBUDDY2API_API_KEY',
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:7863/v1',
        retryPolicy: { mode: 'normal', maxRetries: 0 },
        models: [{ id: 'cn:new', contextWindow: 1000, maxTokens: 100, input: ['text', 'image'], reasoningEfforts: { high: 'high' } }],
      },
    }])
  })

  it('网关不可达 → failed（附原因），且一个字节都不写', async () => {
    let mutateCalls = 0
    const outcome = await seedEditableProvider({
      ...baseDeps,
      catalogAttempts: 2,
      settings: fakeSettings([{ ns: 'llm-pi-ai', schema: providersForm(), value: {} }], () => { mutateCalls += 1 }),
      fetchEntries: async () => { throw new Error('ECONNREFUSED') },
    })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') throw new Error('unreachable')
    expect(outcome.reason).toBe('gateway-unreachable')
    expect(outcome.detail).toContain('ECONNREFUSED')
    expect(outcome.manualBlock).toBeUndefined()
    expect(mutateCalls).toBe(0)
  })

  it('写入失败 → failed 并附上可粘贴的 YAML 块', async () => {
    const outcome = await seedEditableProvider({
      ...baseDeps,
      settings: fakeSettings(
        [{ ns: 'llm-pi-ai', schema: providersForm(), value: {} }],
        () => { throw new Error('Config field "providers.x" is not volatile') },
      ),
      fetchEntries: async () => [entry('cn:new', { contextLength: 1000, maxOutputTokens: 100 })],
      guard: fakeGuard(),
    })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') throw new Error('unreachable')
    expect(outcome.reason).toBe('write-failed')
    expect(outcome.detail).toContain('not volatile')
    expect(outcome.manualBlock).toContain('workbuddy:')
    expect(outcome.manualBlock).toContain('contextWindow: 1000')
  })

  it('settings 服务缺失 / 没有 mutate → skipped，不抛错', async () => {
    const fetchEntries = vi.fn(async () => [])
    await expect(seedEditableProvider({ ...baseDeps, settings: undefined, fetchEntries }))
      .resolves.toMatchObject({ kind: 'skipped', reason: 'no-settings-service' })
    await expect(seedEditableProvider({ ...baseDeps, settings: { describe: () => [] }, fetchEntries }))
      .resolves.toMatchObject({ kind: 'skipped', reason: 'no-settings-service' })
    expect(fetchEntries).not.toHaveBeenCalled()
  })

  it('探测不到 namespace → skipped，且说明指定过什么', async () => {
    const outcome = await seedEditableProvider({
      ...baseDeps,
      namespaceAttempts: 2,
      preferredNamespace: 'llm-pi-ai',
      settings: fakeSettings([{ ns: 'ui-theme', schema: { type: 'object', dict: {} }, value: {} }]),
      fetchEntries: async () => [],
    })
    expect(outcome.kind).toBe('skipped')
    if (outcome.kind !== 'skipped') throw new Error('unreachable')
    expect(outcome.reason).toBe('no-namespace')
    expect(outcome.detail).toContain('llm-pi-ai')
  })

  it('namespace 晚一步才出现时会被重试到（Loader 还没激活条目的真实情形）', async () => {
    let calls = 0
    const outcome = await seedEditableProvider({
      ...baseDeps,
      namespaceAttempts: 5,
      settings: {
        describe: () => {
          calls += 1
          return calls < 3 ? [] : [{ ns: 'llm-pi-ai', revision: 0, schema: providersForm(), value: { providers: { workbuddy: {} } } }]
        },
        mutate: async () => {},
      },
      fetchEntries: async () => [],
    })
    expect(outcome).toMatchObject({ kind: 'present', ns: 'llm-pi-ai' })
    expect(calls).toBe(3)
  })

  it('网关先失败后成功时能恢复（等网关起来）', async () => {
    let attempt = 0
    const outcome = await seedEditableProvider({
      ...baseDeps,
      catalogAttempts: 3,
      settings: fakeSettings([{ ns: 'llm-pi-ai', revision: 0, schema: providersForm(), value: {} }]),
      fetchEntries: async () => {
        attempt += 1
        if (attempt < 3) throw new Error('not ready')
        return [entry('cn:x', { contextLength: 10, maxOutputTokens: 1 })]
      },
      guard: fakeGuard(),
    })
    expect(outcome).toMatchObject({ kind: 'created', ns: 'llm-pi-ai', modelCount: 1 })
    expect(attempt).toBe(3)
  })

  describe('写路径安全网（PROJECT.md §0「写配置铁律」）', () => {
    /** 一个「provider 缺失、目录拉得到、可以写」的现场。 */
    const siteMissingProvider = (onMutate?: (ns: string, ops: unknown[], rev?: number) => void) => ({
      settings: fakeSettings(
        [{ ns: 'llm-pi-ai', revision: 7, schema: providersForm(), value: { providers: { other: {} } } }],
        onMutate,
      ),
      fetchEntries: async () => [entry('cn:new', { contextLength: 1000, maxOutputTokens: 100 })],
    })

    it('🔴 没接线安全网 → 拒绝写入，一个字节都不写', async () => {
      const mutate = vi.fn(async () => {})
      const outcome = await seedEditableProvider({ ...baseDeps, ...siteMissingProvider(mutate) })
      expect(outcome.kind).toBe('failed')
      expect(mutate).not.toHaveBeenCalled()
      if (outcome.kind !== 'failed') throw new Error('unreachable')
      expect(outcome.detail).toContain('安全网')
      // 拒绝写入不等于不管了：手工块照样给出来。
      expect(outcome.manualBlock).toContain('workbuddy:')
    })

    it('🔴 备份失败 → 放弃写入（备份不了就不写，不是"先写再说"）', async () => {
      const mutate = vi.fn(async () => {})
      const outcome = await seedEditableProvider({
        ...baseDeps,
        ...siteMissingProvider(mutate),
        guard: fakeGuard({ snapshot: async () => { throw new Error('EACCES: permission denied') } }),
      })
      expect(outcome.kind).toBe('failed')
      if (outcome.kind !== 'failed') throw new Error('unreachable')
      expect(outcome.detail).toContain('EACCES')
      expect(mutate).not.toHaveBeenCalled()
    })

    it('🔴 写入「成功」但条目从 34 变 3 → rolled-back，并把备份盖回去', async () => {
      let rollbackCalls = 0
      const outcome = await seedEditableProvider({
        ...baseDeps,
        ...siteMissingProvider(),
        guard: fakeGuard({
          verify: async () => ({ ok: false, reasons: ['profile patch 条目数变少：写入前 34 → 写入后 3'] }),
          rollback: async () => { rollbackCalls += 1 },
        }),
      })
      expect(outcome.kind).toBe('rolled-back')
      expect(rollbackCalls).toBe(1)
      if (outcome.kind !== 'rolled-back') throw new Error('unreachable')
      expect(outcome.reasons.join('\n')).toContain('34')
      expect(outcome.recovery).toContain('盖回')
      expect(outcome.manualBlock).toContain('workbuddy:')
    })

    it('verify 收到的基线是写入前那份，期望模型数是本次写进去的数量', async () => {
      const seen: Array<{ entryCount: number; expected: { modelCount: number } }> = []
      await seedEditableProvider({
        ...baseDeps,
        ...siteMissingProvider(),
        guard: fakeGuard({
          verify: async (baseline, expected) => {
            seen.push({ entryCount: baseline.entryCount, expected })
            return { ok: true }
          },
        }),
      })
      expect(seen).toEqual([{ entryCount: 34, expected: { modelCount: 1 } }])
    })

    it('🔴 回滚也失败时给出手工命令（不能只说一句"失败了"）', async () => {
      const outcome = await seedEditableProvider({
        ...baseDeps,
        ...siteMissingProvider(),
        guard: fakeGuard({
          verify: async () => ({ ok: false, reasons: ['条目变少'] }),
          rollback: async () => { throw new Error('EROFS: read-only file system') },
        }),
      })
      expect(outcome.kind).toBe('rolled-back')
      if (outcome.kind !== 'rolled-back') throw new Error('unreachable')
      expect(outcome.recovery).toContain('EROFS')
      expect(outcome.recovery).toContain(outcome.backupPath)
    })

    it('provider 已存在时完全不碰安全网（present 分支既不备份、也不写）', async () => {
      let snapshotCalls = 0
      const outcome = await seedEditableProvider({
        ...baseDeps,
        settings: {
          describe: () => [{
            ns: 'llm-pi-ai',
            revision: 3,
            schema: providersForm(),
            value: { providers: { workbuddy: { models: [{ id: 'a' }] } } },
          }],
          mutate: async () => {},
        },
        fetchEntries: async () => [],
        guard: fakeGuard({ snapshot: async () => { snapshotCalls += 1; return { backupPath: 'x', entryCount: 34, bytes: 1 } } }),
      })
      expect(outcome.kind).toBe('present')
      expect(snapshotCalls).toBe(0)
    })
  })

  describe('--rebuild（显式整份覆盖）', () => {
    /** provider 已存在（配了 kept + gone）、而网关现在有 kept + brand-new 的现场。 */
    const siteExistingProvider = (onMutate?: (ns: string, ops: unknown[], rev?: number) => void) => ({
      settings: fakeSettings(
        [{
          ns: 'llm-pi-ai',
          revision: 9,
          schema: providersForm(),
          value: { providers: { workbuddy: { models: [{ id: 'kept' }, { id: 'gone' }] } } },
        }],
        onMutate,
      ),
      fetchEntries: async () => [
        entry('kept', { contextLength: 100, maxOutputTokens: 10 }),
        entry('brand-new', { contextLength: 200, maxOutputTokens: 20 }),
      ],
    })

    it('🔴 缺省（不 overwrite）时已存在 → present，连目录都不拉', async () => {
      const fetchEntries = vi.fn(async () => [entry('x')])
      const outcome = await seedEditableProvider({
        ...baseDeps,
        settings: fakeSettings([{
          ns: 'llm-pi-ai',
          revision: 9,
          schema: providersForm(),
          value: { providers: { workbuddy: { models: [{ id: 'kept' }] } } },
        }]),
        fetchEntries,
        guard: fakeGuard(),
      })
      expect(outcome).toEqual({ kind: 'present', ns: 'llm-pi-ai', modelCount: 1 })
      expect(fetchEntries).not.toHaveBeenCalled()
    })

    it('overwrite=true 时已存在也重写，并回传 rebuilt 与「丢掉了哪些」', async () => {
      const calls: Array<{ ns: string; ops: unknown[]; rev?: number }> = []
      const outcome = await seedEditableProvider({
        ...baseDeps,
        ...siteExistingProvider((ns, ops, rev) => { calls.push({ ns, ops, rev }) }),
        overwrite: true,
        guard: fakeGuard(),
      })
      expect(outcome.kind).toBe('rebuilt')
      if (outcome.kind !== 'rebuilt') throw new Error('unreachable')
      expect(outcome.modelCount).toBe(2)
      expect(outcome.previousModelCount).toBe(2)
      // 'gone' 原本配了、网关现在没有 → 重建后不在清单里，必须被点名。
      expect(outcome.droppedModels).toEqual(['gone'])
      expect(calls.length).toBe(1)
      expect(calls[0].rev).toBe(9)
    })

    it('overwrite=true 但 provider 本来缺失 → 仍然是 created（不是 rebuilt）', async () => {
      const outcome = await seedEditableProvider({
        ...baseDeps,
        settings: fakeSettings([{ ns: 'llm-pi-ai', revision: 1, schema: providersForm(), value: { providers: {} } }]),
        fetchEntries: async () => [entry('a', { contextLength: 1, maxOutputTokens: 1 })],
        overwrite: true,
        guard: fakeGuard(),
      })
      expect(outcome.kind).toBe('created')
    })

    it('🔴 重建同样过安全网：条目变少 → rolled-back', async () => {
      let rolledBack = 0
      const outcome = await seedEditableProvider({
        ...baseDeps,
        ...siteExistingProvider(),
        overwrite: true,
        guard: fakeGuard({
          verify: async () => ({ ok: false, reasons: ['profile patch 条目数变少：写入前 34 → 写入后 3'] }),
          rollback: async () => { rolledBack += 1 },
        }),
      })
      expect(outcome.kind).toBe('rolled-back')
      expect(rolledBack).toBe(1)
    })

    it('🔴 顺序：备份发生在写入之前（不是写完才想起来备份）', async () => {
      const order: string[] = []
      await seedEditableProvider({
        ...baseDeps,
        ...siteExistingProvider(() => { order.push('mutate') }),
        overwrite: true,
        guard: fakeGuard({
          snapshot: async () => {
            order.push('snapshot')
            return { backupPath: 'b', entryCount: 34, bytes: 1 }
          },
        }),
      })
      expect(order).toEqual(['snapshot', 'mutate'])
    })
  })
})
