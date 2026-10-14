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
  probeNamespaceCandidates,
  providerExists,
  renderNamespaceProbe,
  renderProviderNotes,
  renderProviderProfileYaml,
  seedEditableProvider,
  THINKING_LEVELS,
  type ProviderProfile,
  type SeedDeps,
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

describe('probeNamespaceCandidates / renderNamespaceProbe（把"没找到"变成可诊断）', () => {
  it('describe 返回空 → 空数组；渲染文本点明「0 个条目」并给出可能的解释', () => {
    expect(probeNamespaceCandidates(fakeSettings([]))).toEqual([])
    const text = renderNamespaceProbe([])
    expect(text).toContain('0 个条目')
    expect(text).toContain('已激活')
  })

  it('settings 缺失 / 没有 describe / describe 抛错 → 空数组，都不抛', () => {
    expect(probeNamespaceCandidates(undefined)).toEqual([])
    expect(probeNamespaceCandidates({})).toEqual([])
    expect(probeNamespaceCandidates({ describe: () => { throw new Error('boom') } })).toEqual([])
  })

  it('🔴 逐条报出 schema 形状 —— 这几种故障当初长得一模一样，分不清', () => {
    const probes = probeNamespaceCandidates(fakeSettings([
      { ns: 'llm-pi-ai', schema: providersForm(), value: {} },
      { ns: 'ui-theme', schema: { type: 'object', dict: { accent: { type: 'string' } } }, value: {} },
      { ns: 'weird', schema: { type: 'object', dict: { providers: { type: 'array' } } }, value: {} },
      { ns: 'bare', value: {} },
    ]))
    // schemaPreview 是给人看的 JSON，不参与结构断言。
    expect(probes.map(({ ns, hasSchema, schemaType, dictKeys, providersType, matched }) =>
      ({ ns, hasSchema, schemaType, dictKeys, providersType, matched }))).toEqual([
      { ns: 'llm-pi-ai', hasSchema: true, schemaType: 'object', dictKeys: ['providers'], providersType: 'dict', matched: true },
      { ns: 'ui-theme', hasSchema: true, schemaType: 'object', dictKeys: ['accent'], providersType: undefined, matched: false },
      { ns: 'weird', hasSchema: true, schemaType: 'object', dictKeys: ['providers'], providersType: 'array', matched: false },
      { ns: 'bare', hasSchema: false, schemaType: undefined, dictKeys: [], providersType: undefined, matched: false },
    ])

    const text = renderNamespaceProbe(probes)
    expect(text).toContain('返回了 4 个条目')
    expect(text).toContain('✅ llm-pi-ai')
    // 三种不同的"没匹配上"必须能被区分开。
    expect(text).toContain('describe() 里没有 schema 字段')       // bare：字段根本没有
    expect(text).toContain('dict 键=[accent]')                    // ui-theme：有 dict 但没 providers
    expect(text).toContain('providers.type=array')                // weird：有 providers 但类型不对
  })

  it('🔴 形状对不上时把 schema 的 JSON 摘要打出来（那才是最难的故障）', () => {
    const probes = probeNamespaceCandidates(fakeSettings([
      { ns: 'llm-pi-ai', schema: { type: 'object', dict: { providers: { type: 'list' } } }, value: {} },
    ]))
    expect(probes[0].schemaPreview).toContain('"providers"')
    expect(renderNamespaceProbe(probes)).toContain('↳')
  })

  it('没有 schema 的条目不打 JSON 摘要（20 多条时不至于把输出淹掉）', () => {
    const probes = probeNamespaceCandidates(fakeSettings([{ ns: 'bare', value: {} }]))
    const text = renderNamespaceProbe(probes)
    expect(text).toContain('describe() 里没有 schema 字段')
    expect(text).not.toContain('↳')
  })

  it('schema 无法 JSON 化时不抛错', () => {
    const cyclic: Record<string, unknown> = { type: 'object', dict: {} }
    cyclic.self = cyclic
    const probes = probeNamespaceCandidates(fakeSettings([{ ns: 'cyclic', schema: cyclic, value: {} }]))
    expect(probes[0].schemaPreview).toBe('(无法 JSON 化)')
    expect(probes[0].hasSchema).toBe(true)
  })

  it('🔴 no-namespace 的 detail 里带上实际探测结果（不再只说"没找到"）', async () => {
    const outcome = await seedEditableProvider({
      providerName: 'workbuddy',
      preferredNamespace: '',
      apiKeyEnv: 'WORKBUDDY2API_API_KEY',
      baseURL: 'http://127.0.0.1:7863/v1',
      sleep: async () => {},
      namespaceAttempts: 1,
      settings: fakeSettings([{ ns: 'ui-theme', schema: { type: 'object', dict: {} }, value: {} }]),
      fetchEntries: async () => [],
    })
    expect(outcome.kind).toBe('skipped')
    if (outcome.kind !== 'skipped') throw new Error('unreachable')
    expect(outcome.detail).toContain('ui-theme')
    expect(outcome.detail).toContain('返回了 1 个条目')
  })

  describe('🔴 引用表形态 {uid, refs} —— 真机上的实际形状（2026-10-14 之前完全没被识别）', () => {
    /** 造一个 schemastery 引用表；`providers` 处可放数字 id、数字字符串或内联节点。 */
    function refTable(providers: unknown): Record<string, unknown> {
      return {
        uid: 100,
        refs: {
          100: { type: 'object', meta: { default: {} }, dict: { providers } },
          200: { type: 'dict', meta: {}, inner: 201 },
          201: { type: 'object', meta: {}, dict: {} },
        },
      }
    }

    const probeOne = (schema: unknown) =>
      probeNamespaceCandidates(fakeSettings([{ ns: 'llm-pi-ai', schema, value: {} }]))[0]

    it('providers 用数字 id 引用到 dict 节点 → 识别', () => {
      expect(probeOne(refTable(200))).toMatchObject({
        form: 'refs', schemaType: 'object', dictKeys: ['providers'], providersType: 'dict', matched: true,
      })
    })

    it('providers 用数字字符串引用 → 也识别', () => {
      expect(probeOne(refTable('200')).matched).toBe(true)
    })

    it('providers 直接内联在 dict 里 → 也识别', () => {
      expect(probeOne(refTable({ type: 'dict', meta: {} })).matched).toBe(true)
    })

    it('providers 指向的节点不是 dict → 不识别，但类型要如实报出来', () => {
      const table = {
        uid: 100,
        refs: { 100: { type: 'object', dict: { providers: 200 } }, 200: { type: 'list', meta: {} } },
      }
      expect(probeOne(table)).toMatchObject({ form: 'refs', providersType: 'list', matched: false })
    })

    it('根节点不是 object → 不识别', () => {
      expect(probeOne({ uid: 100, refs: { 100: { type: 'string', dict: {} } } }).matched).toBe(false)
    })

    it('providers 指向不存在的 id → 不识别，也不抛错', () => {
      expect(probeOne(refTable(999))).toMatchObject({ form: 'refs', providersType: undefined, matched: false })
    })

    it('自引用成环不会挂死', () => {
      const refs: Record<string, unknown> = { 100: { type: 'object', dict: { providers: 101 } } }
      refs[101] = refs[100]
      expect(probeOne({ uid: 100, refs }).matched).toBe(false)
    })

    it('渲染时标出形态是 refs', () => {
      const text = renderNamespaceProbe([probeOne(refTable(200))])
      expect(text).toContain('✅ llm-pi-ai')
      expect(text).toContain('形态=refs')
    })

    it('🔴 端到端：引用表形态下 seedEditableProvider 必须能探测到 namespace 并写入', async () => {
      const calls: Array<{ ns: string; ops: unknown[]; rev?: number }> = []
      const outcome = await seedEditableProvider({
        providerName: 'workbuddy',
        preferredNamespace: '',
        apiKeyEnv: 'WORKBUDDY2API_API_KEY',
        baseURL: 'http://127.0.0.1:7863/v1',
        sleep: async () => {},
        namespaceAttempts: 1,
        settings: fakeSettings(
          [{ ns: 'llm-pi-ai', revision: 3, schema: refTable(200), value: { providers: { other: {} } } }],
          (ns, ops, rev) => { calls.push({ ns, ops, rev }) },
        ),
        fetchEntries: async () => [entry('cn:x', { contextLength: 100, maxOutputTokens: 10 })],
        guard: fakeGuard(),
      })
      expect(outcome.kind).toBe('created')
      expect(calls.length).toBe(1)
      expect(calls[0].ns).toBe('llm-pi-ai')
    })

    it('🔴 内联形态仍然照旧可用（不能为了修 refs 而弄坏原有的）', () => {
      expect(probeOne(providersForm())).toMatchObject({ form: 'inline', providersType: 'dict', matched: true })
    })
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

  it('🔴 残缺的既有条目（只有一行 - id）不会把渲染搞崩，input 按「仅文本」补', () => {
    // 只增不删的写回会把操作员手写的旧条目原样带进来 —— 它们未必是本模块生成的。
    // 这段渲染在**失败路径**上给操作员抄退路，退路自己崩掉就等于没有退路。
    const profile = {
      apiKeyEnv: 'K',
      api: 'openai-completions',
      baseURL: 'http://h/v1',
      retryPolicy: { mode: 'normal', maxRetries: 0 },
      models: [{ id: 'bare' } as unknown as ProviderProfile['models'][number]],
    }
    let yaml = ''
    expect(() => { yaml = renderProviderProfileYaml('workbuddy', profile) }).not.toThrow()
    expect(yaml).toContain('- id: bare')
    expect(yaml).toContain('        - text')
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
    expect(outcome).toEqual({
      kind: 'present', ns: 'llm-pi-ai', modelCount: 2, offeredModels: ['a', 'b'], offeredRecorded: false,
    })
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

  describe('--rebuild（只增不删 / 墓碑集合）', () => {
    /**
     * 造一个「provider 已存在、网关目录给定」的现场。
     *
     * `offered` 是墓碑（上一次提供过的 id）：`undefined` = **没有记录**，
     * 空数组 = **有记录，一个都没提供过**。这两个语义分开是本组的重点之一。
     */
    function site(options: {
      models: unknown[]
      catalog: string[]
      offered?: string[] | undefined
      readThrows?: boolean
      onMutate?: (ns: string, ops: unknown[], rev?: number) => void
      guard?: WriteGuard
    }): { deps: SeedDeps; writes: string[][] } {
      const writes: string[][] = []
      const deps: SeedDeps = {
        ...baseDeps,
        // 现场默认就是「操作员敲了 --rebuild」——这一组的全部用例都在验刷新路径。
        overwrite: true,
        settings: fakeSettings(
          [{
            ns: 'llm-pi-ai',
            revision: 9,
            schema: providersForm(),
            value: { providers: { workbuddy: { apiKeyEnv: 'X', models: options.models } } },
          }],
          options.onMutate,
        ),
        fetchEntries: async () =>
          options.catalog.map(id => entry(id, { contextLength: 100, maxOutputTokens: 10 })),
        readOffered: async () => {
          if (options.readThrows === true) throw new Error('EACCES: 读不到状态文件')
          return options.offered
        },
        writeOffered: async (ids) => { writes.push([...ids]) },
        guard: options.guard ?? fakeGuard(),
      }
      return { deps, writes }
    }

    /** 取某次 mutate 写进去的模型 id 列表。 */
    function writtenIds(ops: unknown[]): string[] {
      const value = (ops[0] as { value?: { models?: Array<{ id?: unknown }> } }).value
      return (value?.models ?? []).map(model => String(model.id))
    }

    it('🔴 缺省（不 overwrite）时已存在 → present，连目录都不拉', async () => {
      const fetchEntries = vi.fn(async () => [entry('x')])
      const mutate = vi.fn(async () => {})
      const outcome = await seedEditableProvider({
        ...baseDeps,
        settings: fakeSettings([{
          ns: 'llm-pi-ai',
          revision: 9,
          schema: providersForm(),
          value: { providers: { workbuddy: { models: [{ id: 'kept' }] } } },
        }], mutate),
        fetchEntries,
        guard: fakeGuard(),
      })
      expect(outcome).toEqual({
        kind: 'present', ns: 'llm-pi-ai', modelCount: 1, offeredModels: ['kept'], offeredRecorded: false,
      })
      expect(fetchEntries).not.toHaveBeenCalled()
      expect(mutate).not.toHaveBeenCalled()
    })

    it('🔴 核心不变量：用户删掉的 id 不会复活（kept=[a]、墓碑=[a,b]、网关=[a,b,c] ⇒ 只加 c）', async () => {
      const calls: Array<{ ns: string; ops: unknown[]; rev?: number }> = []
      const { deps, writes } = site({
        models: [{ id: 'a' }],
        catalog: ['a', 'b', 'c'],
        offered: ['a', 'b'],
        onMutate: (ns, ops, rev) => { calls.push({ ns, ops, rev }) },
      })
      const outcome = await seedEditableProvider(deps)
      expect(outcome.kind).toBe('rebuilt')
      if (outcome.kind !== 'rebuilt') throw new Error('unreachable')
      expect(outcome.addedModels).toEqual(['c'])
      expect(outcome.keptModels).toBe(1)
      expect(outcome.offeredModels).toEqual(['a', 'b', 'c'])
      expect(calls.length).toBe(1)
      expect(calls[0].rev).toBe(9)
      // b 在墓碑里 ⇒ 不写回去；a 原样保留。
      expect(writtenIds(calls[0].ops)).toEqual(['a', 'c'])
      // 墓碑 = 上一轮 ∪ 保留的 ∪ 新增的（删掉过的 b 不能被抹掉，否则下一轮它就会回来）
      expect(writes).toEqual([['a', 'b', 'c']])
    })

    it('🔴 没有墓碑记录时：一个都不加，把原因说出来，并立起基线', async () => {
      const mutate = vi.fn(async () => {})
      const { deps, writes } = site({
        models: [{ id: 'a' }, { id: 'b' }],
        catalog: ['a', 'b', 'c'],
        offered: undefined,
        onMutate: mutate,
      })
      const outcome = await seedEditableProvider(deps)
      expect(outcome.kind).toBe('rebuilt')
      if (outcome.kind !== 'rebuilt') throw new Error('unreachable')
      expect(outcome.addedModels).toEqual([])
      expect(outcome.keptModels).toBe(2)
      expect(outcome.holdReason).toContain('没有上一次')
      expect(outcome.holdReason).toContain('一个都不加')
      expect(mutate).not.toHaveBeenCalled()
      // 基线 = 保留的 ∪ 网关当前目录：本次一个都没加，但从这一刻起机制开始工作。
      expect(writes).toEqual([['a', 'b', 'c']])
    })

    it('🔴 added 为空 ⇒ 不写 patch、不碰安全网、不写墓碑', async () => {
      let snapshotCalls = 0
      const mutate = vi.fn(async () => {})
      const { deps, writes } = site({
        models: [{ id: 'a' }, { id: 'b' }],
        catalog: ['a', 'b'],
        offered: ['a', 'b', 'c'],
        onMutate: mutate,
        guard: fakeGuard({
          snapshot: async () => {
            snapshotCalls += 1
            return { backupPath: 'b', entryCount: 34, bytes: 1 }
          },
        }),
      })
      const outcome = await seedEditableProvider(deps)
      expect(outcome.kind).toBe('rebuilt')
      if (outcome.kind !== 'rebuilt') throw new Error('unreachable')
      expect(outcome.addedModels).toEqual([])
      expect(outcome.holdReason).toBeUndefined()
      expect(outcome.backupPath).toBeUndefined()
      expect(mutate).not.toHaveBeenCalled()
      expect(snapshotCalls).toBe(0)
      expect(writes).toEqual([])
    })

    it('🔴「墓碑是空数组」≠「没有记录」：知道一个都没提供过 ⇒ 该加的都加', async () => {
      const { deps } = site({ models: [{ id: 'a' }], catalog: ['a', 'b'], offered: [] })
      const outcome = await seedEditableProvider(deps)
      expect(outcome.kind).toBe('rebuilt')
      if (outcome.kind !== 'rebuilt') throw new Error('unreachable')
      expect(outcome.addedModels).toEqual(['b'])
      expect(outcome.holdReason).toBeUndefined()
    })

    it('读墓碑抛错 ⇒ 当成「没有记录」，降级不抛错，仍然一个都不加', async () => {
      const { deps } = site({ models: [{ id: 'a' }], catalog: ['a', 'b'], readThrows: true })
      const outcome = await seedEditableProvider(deps)
      expect(outcome.kind).toBe('rebuilt')
      if (outcome.kind !== 'rebuilt') throw new Error('unreachable')
      expect(outcome.addedModels).toEqual([])
      expect(outcome.holdReason).toBeDefined()
    })

    it('没接线墓碑（readOffered 缺席）⇒ 同样走保守路径，不抛错', async () => {
      const { deps } = site({ models: [{ id: 'a' }], catalog: ['a', 'b'] })
      delete deps.readOffered
      delete deps.writeOffered
      const outcome = await seedEditableProvider(deps)
      expect(outcome.kind).toBe('rebuilt')
      if (outcome.kind !== 'rebuilt') throw new Error('unreachable')
      expect(outcome.addedModels).toEqual([])
      expect(outcome.holdReason).toBeDefined()
    })

    it('🔴 墓碑写回失败 ⇒ provider 写入的结果不受影响，只在 stateWarning 里注明', async () => {
      const writes: string[][] = []
      const { deps } = site({ models: [{ id: 'a' }], catalog: ['a', 'c'], offered: ['a'] })
      deps.writeOffered = async (ids) => {
        writes.push([...ids])
        throw new Error('EROFS: read-only file system')
      }
      const outcome = await seedEditableProvider(deps)
      expect(outcome.kind).toBe('rebuilt')
      if (outcome.kind !== 'rebuilt') throw new Error('unreachable')
      expect(outcome.addedModels).toEqual(['c'])
      expect(outcome.backupPath).toBeDefined()
      expect(outcome.stateWarning).toContain('EROFS')
      expect(outcome.stateWarning).toContain('不影响')
      expect(writes).toEqual([['a', 'c']])
    })

    it('🔴 kept 的条目原样保留：用户调过的数值不会被网关的实测值覆盖', async () => {
      const calls: Array<{ ops: unknown[] }> = []
      const { deps } = site({
        models: [{ id: 'a', contextWindow: 12345, maxTokens: 678, input: ['text'] }],
        catalog: ['a', 'c'],
        offered: ['a'],
        onMutate: (_ns, ops) => { calls.push({ ops }) },
      })
      await seedEditableProvider(deps)
      const models = (calls[0].ops[0] as { value: { models: unknown[] } }).value.models
      expect(models[0]).toEqual({ id: 'a', contextWindow: 12345, maxTokens: 678, input: ['text'] })
      expect(models).toHaveLength(2)
    })

    it('🔴 重建同样过安全网：写前备份 → 写 → 按「保留 + 新增」核对 → 不对就回滚（且不写墓碑）', async () => {
      const order: string[] = []
      const expectedCounts: number[] = []
      const { deps, writes } = site({
        models: [{ id: 'a' }, { id: 'b' }],
        catalog: ['a', 'b', 'c'],
        offered: ['a', 'b'],
        onMutate: () => { order.push('mutate') },
        guard: fakeGuard({
          snapshot: async () => {
            order.push('snapshot')
            return { backupPath: 'bak', entryCount: 34, bytes: 1 }
          },
          verify: async (_baseline, expected) => {
            expectedCounts.push(expected.modelCount)
            return { ok: true }
          },
        }),
      })
      const outcome = await seedEditableProvider(deps)
      expect(order).toEqual(['snapshot', 'mutate'])
      expect(expectedCounts).toEqual([3])
      expect(outcome.kind).toBe('rebuilt')
      if (outcome.kind !== 'rebuilt') throw new Error('unreachable')
      expect(outcome.backupPath).toBe('bak')
      expect(writes).toEqual([['a', 'b', 'c']])
    })

    it('🔴 重建判定不通过 ⇒ rolled-back，且绝不写墓碑', async () => {
      let rolledBack = 0
      const { deps, writes } = site({
        models: [{ id: 'a' }],
        catalog: ['a', 'c'],
        offered: ['a'],
        guard: fakeGuard({
          verify: async () => ({ ok: false, reasons: ['profile patch 条目数变少：写入前 34 → 写入后 3'] }),
          rollback: async () => { rolledBack += 1 },
        }),
      })
      const outcome = await seedEditableProvider(deps)
      expect(outcome.kind).toBe('rolled-back')
      expect(rolledBack).toBe(1)
      expect(writes).toEqual([])
    })

    it('重建时没接线安全网 ⇒ failed，一个字节都不写、也不写墓碑', async () => {
      const { deps, writes } = site({ models: [{ id: 'a' }], catalog: ['a', 'c'], offered: ['a'] })
      delete deps.guard
      const outcome = await seedEditableProvider(deps)
      expect(outcome.kind).toBe('failed')
      if (outcome.kind !== 'failed') throw new Error('unreachable')
      expect(outcome.detail).toContain('安全网')
      // 手工块给的是**合并后**的清单（贴回去等价于「只增不删」，不是整份覆盖）
      expect(outcome.manualBlock).toContain('c')
      expect(writes).toEqual([])
    })

    it('overwrite=true 但 provider 本来缺失 → created（不是 rebuilt），并把全部 id 记为提供过', async () => {
      const writes: string[][] = []
      const outcome = await seedEditableProvider({
        ...baseDeps,
        settings: fakeSettings([{ ns: 'llm-pi-ai', revision: 1, schema: providersForm(), value: { providers: {} } }]),
        fetchEntries: async () => [
          entry('a', { contextLength: 1, maxOutputTokens: 1 }),
          entry('b', { contextLength: 1, maxOutputTokens: 1 }),
        ],
        overwrite: true,
        guard: fakeGuard(),
        writeOffered: async (ids) => { writes.push([...ids]) },
      })
      expect(outcome.kind).toBe('created')
      if (outcome.kind !== 'created') throw new Error('unreachable')
      expect(outcome.offeredModels).toEqual(['a', 'b'])
      expect(writes).toEqual([['a', 'b']])
    })
  })

  describe('墓碑写回时机（严格：failed / rolled-back / skipped 绝不写）', () => {
    const existing = (models: unknown[] = [{ id: 'a' }]) => fakeSettings([{
      ns: 'llm-pi-ai',
      revision: 3,
      schema: providersForm(),
      value: { providers: { workbuddy: { models } } },
    }])

    it('present ⇒ 写「上一轮墓碑 ∪ 当前配置里的 id」（删掉过的 id 不能被抹掉）', async () => {
      const writes: string[][] = []
      const outcome = await seedEditableProvider({
        ...baseDeps,
        settings: existing([{ id: 'a' }]),
        fetchEntries: async () => { throw new Error('present 不该拉目录') },
        readOffered: async () => ['a', 'b'],
        writeOffered: async (ids) => { writes.push([...ids]) },
      })
      expect(outcome).toMatchObject({ kind: 'present', ns: 'llm-pi-ai', modelCount: 1 })
      if (outcome.kind !== 'present') throw new Error('unreachable')
      expect(outcome.offeredModels).toEqual(['a', 'b'])
      expect(outcome.offeredRecorded).toBe(true)
      expect(writes).toEqual([['a', 'b']])
    })

    it('🔴 present 且没有旧记录 ⇒ **不写**任何记录（不拿当前配置去造基线）', async () => {
      // 拿"用户留着的"当"我们提供过的"，下一次 --rebuild 就会把他删掉的模型全加回来。
      const writes: string[][] = []
      const outcome = await seedEditableProvider({
        ...baseDeps,
        settings: existing([{ id: 'a' }, { id: 'b' }]),
        fetchEntries: async () => { throw new Error('present 不该拉目录') },
        writeOffered: async (ids) => { writes.push([...ids]) },
      })
      if (outcome.kind !== 'present') throw new Error('unreachable')
      expect(outcome.offeredRecorded).toBe(false)
      expect(outcome.offeredModels).toEqual(['a', 'b'])
      expect(writes).toEqual([])
    })

    it('🔴 升级路径：老 provider 先 present（不造记录）⇒ 第一次 --rebuild 一个都不加', async () => {
      // 用户在这个版本之前就删掉过模型：插件手上没有任何"提供过"的记录，
      // 于是第一次 --rebuild 必须保守 —— 加错就是复活他删掉的模型。
      let stored: string[] | undefined
      const first = await seedEditableProvider({
        ...baseDeps,
        settings: existing([{ id: 'a' }]),
        fetchEntries: async () => { throw new Error('present 不该拉目录') },
        readOffered: async () => stored,
        writeOffered: async (ids) => { stored = [...ids] },
      })
      expect(first.kind).toBe('present')
      expect(stored).toBeUndefined()

      const writes: string[][] = []
      const second = await seedEditableProvider({
        ...baseDeps,
        overwrite: true,
        settings: existing([{ id: 'a' }]),
        fetchEntries: async () => [entry('a', { contextLength: 1, maxOutputTokens: 1 }), entry('b', { contextLength: 1, maxOutputTokens: 1 })],
        readOffered: async () => stored,
        writeOffered: async (ids) => { writes.push([...ids]); stored = [...ids] },
      })
      expect(second.kind).toBe('rebuilt')
      if (second.kind !== 'rebuilt') throw new Error('unreachable')
      expect(second.addedModels).toEqual([])
      expect(second.holdReason).toBeDefined()
      // 基线立起来了：保留的 ∪ 网关目录；下一次刷新才会开始"只补新增"。
      expect(writes).toEqual([['a', 'b']])
    })

    it('present 时墓碑写失败 ⇒ 结果仍是 present + stateWarning（配置没被写，所以也没得回滚）', async () => {
      const outcome = await seedEditableProvider({
        ...baseDeps,
        settings: existing([{ id: 'a' }]),
        fetchEntries: async () => { throw new Error('present 不该拉目录') },
        readOffered: async () => ['a'],
        writeOffered: async () => { throw new Error('EACCES') },
      })
      expect(outcome.kind).toBe('present')
      if (outcome.kind !== 'present') throw new Error('unreachable')
      expect(outcome.stateWarning).toContain('EACCES')
    })

    it('created ⇒ 写全部 id；写失败也只是 stateWarning，created 照样成立', async () => {
      const outcome = await seedEditableProvider({
        ...baseDeps,
        settings: fakeSettings([{ ns: 'llm-pi-ai', revision: 1, schema: providersForm(), value: { providers: {} } }]),
        fetchEntries: async () => [entry('a', { contextLength: 1, maxOutputTokens: 1 })],
        guard: fakeGuard(),
        writeOffered: async () => { throw new Error('ENOSPC') },
      })
      expect(outcome.kind).toBe('created')
      if (outcome.kind !== 'created') throw new Error('unreachable')
      expect(outcome.offeredModels).toEqual(['a'])
      expect(outcome.stateWarning).toContain('ENOSPC')
      expect(outcome.stateWarning).toContain('不影响')
    })

    it('created 的回滚分支 ⇒ 不写墓碑', async () => {
      const writes: string[][] = []
      const outcome = await seedEditableProvider({
        ...baseDeps,
        settings: fakeSettings([{ ns: 'llm-pi-ai', revision: 1, schema: providersForm(), value: { providers: {} } }]),
        fetchEntries: async () => [entry('a', { contextLength: 1, maxOutputTokens: 1 })],
        guard: fakeGuard({ verify: async () => ({ ok: false, reasons: ['条目变少'] }) }),
        writeOffered: async (ids) => { writes.push([...ids]) },
      })
      expect(outcome.kind).toBe('rolled-back')
      expect(writes).toEqual([])
    })

    it('写入抛错 ⇒ failed，不写墓碑', async () => {
      const writes: string[][] = []
      const outcome = await seedEditableProvider({
        ...baseDeps,
        settings: fakeSettings(
          [{ ns: 'llm-pi-ai', schema: providersForm(), value: { providers: {} } }],
          () => { throw new Error('not volatile') },
        ),
        fetchEntries: async () => [entry('a', { contextLength: 1, maxOutputTokens: 1 })],
        guard: fakeGuard(),
        writeOffered: async (ids) => { writes.push([...ids]) },
      })
      expect(outcome.kind).toBe('failed')
      expect(writes).toEqual([])
    })

    it('网关不可达 ⇒ failed，不写墓碑', async () => {
      const writes: string[][] = []
      const outcome = await seedEditableProvider({
        ...baseDeps,
        catalogAttempts: 1,
        settings: fakeSettings([{ ns: 'llm-pi-ai', schema: providersForm(), value: { providers: {} } }]),
        fetchEntries: async () => { throw new Error('ECONNREFUSED') },
        writeOffered: async (ids) => { writes.push([...ids]) },
      })
      expect(outcome.kind).toBe('failed')
      expect(writes).toEqual([])
    })

    it('skipped（没有 settings / 没有 namespace）⇒ 不写墓碑', async () => {
      const writes: string[][] = []
      const noSettings = await seedEditableProvider({
        ...baseDeps,
        settings: undefined,
        fetchEntries: async () => [],
        writeOffered: async (ids) => { writes.push([...ids]) },
      })
      expect(noSettings.kind).toBe('skipped')
      const noNamespace = await seedEditableProvider({
        ...baseDeps,
        namespaceAttempts: 1,
        settings: fakeSettings([{ ns: 'ui-theme', schema: { type: 'object', dict: {} }, value: {} }]),
        fetchEntries: async () => [],
        writeOffered: async (ids) => { writes.push([...ids]) },
      })
      expect(noNamespace.kind).toBe('skipped')
      expect(writes).toEqual([])
    })
  })
})
