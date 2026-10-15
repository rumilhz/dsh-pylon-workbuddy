/**
 * 设置卡片**后端半边**的契约测试（`src/api.ts`）。
 *
 * 这套测试存在的理由，与 `api.ts` 被拆成「数据面 / 传输面」两半是同一件事：
 * 卡片是**浏览器里**的东西，而网关要 Bearer、要回环、要过宿主栅栏 —— 真机上
 * 任何一环断了都会表现成"卡片空白"。所以这里把三件事钉死：
 *
 *   1. **响应形状**：前端照着 `panel` 的字段写，字段少了/类型飘了就是白屏；
 *   2. **诚实度**：拿不到就给 `null` / `ok:false` + `detail`，**绝不假装有数据**；
 *   3. **没有隐式动作**：`panel` 只发 GET、绝不触发 rebuild/checkin/test；
 *      `test` 不带 `confirm` 时**一个请求都不发**（它会真的花额度）；
 *      签到**只在被调用时**才发请求（官方明文禁止自动刷活跃，这是合规红线）。
 *
 * 路由层（注册 / 反注册 / 双前缀 / 栅栏）用替身 ctx 与真 HTTP server 驱动，
 * 不需要真 cordis、不需要真 DSH、不碰网络。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createHostRouteHandler,
  createPanelApi,
  isLoopbackPortHop,
  pickCheckinAccount,
  registerPanelRoutes,
  renderCheckinTrace,
  ROUTE_PATHS,
  stripRoutePrefix,
  type PanelApi,
  type PanelApiDeps,
  type PanelRouteContext,
} from '../../src/api.js'
import { readAuthFile, requestDailyCheckin } from '../../src/login.js'
import type { AuthAccount } from '../../src/accounts.js'

/* ── 夹具 ─────────────────────────────────────────────────────────────────── */

/** 本机实测形态：昵称字段里装的是**手机号**。 */
const PHONE = '18612345617'
const MASKED = '186****5617'

const ACCOUNTS: AuthAccount[] = [
  {
    uid: 'oneid_186',
    nickname: PHONE,
    realm: 'cn',
    domain: 'copilot.tencent.com',
    file: 'C:/wb2api/auths/workbuddy-oneid_186.json',
    enabled: true,
  },
  {
    uid: 'oneid_alice',
    nickname: 'alice',
    realm: 'cn',
    domain: 'copilot.tencent.com',
    file: 'C:/wb2api/auths/workbuddy-oneid_alice.json.disabled',
    enabled: false,
  },
]

/** 网关 `/status`（本机实测形状的精简版）。 */
const STATUS_BODY = {
  accounts: [
    { uid: 'oneid_186', realm: 'cn', nickname: PHONE, credits: 3046, cooling: false, disabled: false },
    { uid: 'oneid_alice', realm: 'cn', nickname: 'alice', credits: 12, cooling: true, disabled: false },
  ],
  cooling: 1,
  disabled: 0,
  healthy: 1,
  total: 2,
}

/** `/v1/models`：48 条里 12 条没有 `credits`（本机实测的两个数）。 */
function catalogBody(): unknown {
  const data = Array.from({ length: 48 }, (_, index) => ({
    id: `cn:m${String(index)}`,
    context_length: 200000,
    ...index < 36 ? { credits: index < 5 ? 'x0.00' : 'x0.21' } : {},
  }))
  return { object: 'list', data }
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

interface FakeGateway {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>
  calls: Call[]
}

/**
 * 假网关：按端点回可控载荷，并把**每一次调用**记下来。
 *
 * 记录本身是断言的一部分：`panel` 是不是只发 GET、`test` 缺 confirm 时是不是
 * 一个请求都没发，都要靠它。
 */
function fakeGateway(options: {
  reachable?: boolean
  stats?: unknown
  chatStatus?: number
  chatBody?: unknown
  models?: unknown
  status?: unknown
} = {}): FakeGateway {
  const calls: Call[] = []
  const reachable = options.reachable ?? true
  const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }
    calls.push({ url, method: init?.method ?? 'GET', headers, ...init?.body !== undefined ? { body: String(init.body) } : {} })
    if (!reachable) throw new Error('ECONNREFUSED 127.0.0.1:7863')

    if (url.endsWith('/healthz')) return json({ healthy: 1, total: 1, realm_servable: { cn: true, global: false } })
    if (url.endsWith('/status')) return json(options.status ?? STATUS_BODY)
    if (url.endsWith('/v1/stats')) {
      return json(options.stats ?? { enabled: true, since: '2026-10-14T22:57:51+08:00', uptime_sec: 2793, total: { requests: 0, credit: 0 }, models: [] })
    }
    if (url.endsWith('/models')) return json(options.models ?? catalogBody())
    if (url.endsWith('/chat/completions')) {
      return json(
        options.chatBody ?? { choices: [{ message: { role: 'assistant', content: '可以' } }], usage: { total_tokens: 7 } },
        options.chatStatus ?? 200,
      )
    }
    return json({}, 404)
  }
  return { fetchImpl, calls }
}

/** 一份最小可用的 deps（测试里只覆盖关心的那几项）。 */
function makeDeps(gateway: FakeGateway, overrides: Partial<PanelApiDeps> = {}): PanelApiDeps {
  return {
    baseURL: 'http://127.0.0.1:7863/v1',
    providerName: 'workbuddy',
    timeoutMs: 1000,
    resolveApiKey: async () => 'test-key',
    fetchImpl: gateway.fetchImpl,
    listAccounts: () => ACCOUNTS,
    providerFacts: async () => ({ exists: true, ns: 'llm-pi-ai', modelCount: 46 }),
    lastOffered: () => 48,
    rebuild: async () => {
      throw new Error('不该在 panel 路径上被调用')
    },
    resetRebuild: async () => {
      throw new Error('不该在 panel 路径上被调用')
    },
    checkin: async () => {
      throw new Error('不该在 panel 路径上被调用')
    },
    trace: () => undefined,
    ...overrides,
  }
}

/* ── panel：响应形状与诚实度 ──────────────────────────────────────────────── */

describe('GET <prefix>/panel —— 卡片要的全部数据', () => {
  it('六段齐全、类型对，且 nickname 已脱敏', async () => {
    const gateway = fakeGateway()
    const body = await createPanelApi(makeDeps(gateway)).panel()

    expect(body.ok).toBe(true)
    expect(Object.keys(body).sort()).toEqual(['checkin', 'credits', 'gateway', 'models', 'ok', 'provider', 'usage'])

    expect(body.gateway).toEqual({ reachable: true, origin: 'http://127.0.0.1:7863', healthy: 1, total: 2 })
    expect(body.credits?.total).toBe(3046 + 12)
    expect(body.credits?.accounts).toHaveLength(2)
    // ★ 手机号形态必须打码（`/status.nickname` 在本机就是手机号）。
    expect(body.credits?.accounts[0]).toEqual({
      uid: 'oneid_186',
      nickname: MASKED,
      realm: 'cn',
      credits: 3046,
      cooling: false,
      disabled: false,
    })
    // 非手机号**一个字符都不动**（一律打码会让账号列表失去可辨识性）。
    expect(body.credits?.accounts[1]?.nickname).toBe('alice')
    // 文件被改名禁用 ⇒ disabled 为真，且网关报的冷却也如实透出。
    expect(body.credits?.accounts[1]).toMatchObject({ disabled: true, cooling: true })

    expect(body.models).toEqual({ gatewayTotal: 48, unknownPrice: 12, providerModelCount: 46 })
    expect(body.provider).toEqual({ exists: true, ns: 'llm-pi-ai', lastOffered: 48 })
    expect(body.usage?.uptimeSec).toBe(2793)
    expect(body.usage?.since).toBe('2026-10-14T22:57:51+08:00')
    expect(body.checkin.supported).toBe(true)
    expect(body.checkin.note).toContain('直连上游')
  })

  it('nickname 两边都拿不到 ⇒ 空串，不炸（渲染层自己决定怎么显示无昵称）', async () => {
    const gateway = fakeGateway({ status: { accounts: [{ uid: 'oneid_186', realm: 'cn', credits: 7 }], healthy: 1, total: 1 } })
    const nameless: AuthAccount[] = [{ ...ACCOUNTS[0]!, nickname: '' }]
    const body = await createPanelApi(makeDeps(gateway, { listAccounts: () => nameless })).panel()
    expect(body.ok).toBe(true)
    expect(body.credits?.accounts[0]).toMatchObject({ nickname: '', credits: 7, cooling: false, disabled: false })
  })

  it('网关没报昵称时回落到本地凭证文件的昵称（同一份账号，别显示成"无昵称"）', async () => {
    const gateway = fakeGateway({ status: { accounts: [{ uid: 'oneid_186', realm: 'cn', credits: 7 }], healthy: 1, total: 1 } })
    const body = await createPanelApi(makeDeps(gateway)).panel()
    // 本地文件里那份也是手机号 ⇒ 照样打码。
    expect(body.credits?.accounts[0]?.nickname).toBe(MASKED)
  })

  it('网关不可达 ⇒ ok:false + detail，不抛；拿不到的一律 null', async () => {
    const gateway = fakeGateway({ reachable: false })
    const body = await createPanelApi(makeDeps(gateway)).panel()

    expect(body.ok).toBe(false)
    expect(body.detail).toContain('网关不可达')
    expect(body.gateway).toEqual({ reachable: false, origin: 'http://127.0.0.1:7863', healthy: null, total: null })
    expect(body.credits).toBeNull()
    expect(body.usage).toBeNull()
    expect(body.models).toEqual({ gatewayTotal: null, unknownPrice: null, providerModelCount: 46 })
    // provider 现状是本地读的，网关挂了它照样有值 —— 这正是"能拿到的照给"。
    expect(body.provider).toEqual({ exists: true, ns: 'llm-pi-ai', lastOffered: 48 })
  })

  it('panel 是纯只读的：一次 POST 都没有', async () => {
    const gateway = fakeGateway()
    await createPanelApi(makeDeps(gateway)).panel()
    expect(gateway.calls.length).toBeGreaterThan(0)
    expect(gateway.calls.every(call => call.method === 'GET')).toBe(true)
    // 只读探针里不该出现任何会改状态/花额度的端点。
    expect(gateway.calls.some(call => call.url.includes('/chat/completions'))).toBe(false)
    expect(gateway.calls.some(call => call.url.includes('stats/reset'))).toBe(false)
  })

  it('provider 现状拿不到（settings 不可用）⇒ exists=false / null，不假装有', async () => {
    const gateway = fakeGateway()
    const body = await createPanelApi(makeDeps(gateway, { providerFacts: async () => undefined, lastOffered: () => undefined })).panel()
    expect(body.provider).toEqual({ exists: false, ns: null, lastOffered: null })
    expect(body.models.providerModelCount).toBeNull()
  })

  it('没有启用的 CN 账号 ⇒ checkin.supported=false（并说明为什么）', async () => {
    const gateway = fakeGateway()
    const globalOnly: AuthAccount[] = [{ ...ACCOUNTS[0]!, realm: 'global', nickname: 'alice' }]
    const body = await createPanelApi(makeDeps(gateway, { listAccounts: () => globalOnly })).panel()
    expect(body.checkin.supported).toBe(false)
    expect(body.checkin.note).toContain('没有启用的 CN 账号')
  })
})

/* ── action：rebuild ─────────────────────────────────────────────────────── */

describe('POST <prefix>/action { action: "rebuild" }', () => {
  it('走的是 --rebuild 那条路径，回执是计数 + 具体 id', async () => {
    const gateway = fakeGateway()
    let calls = 0
    const api = createPanelApi(makeDeps(gateway, {
      rebuild: async () => {
        calls += 1
        return {
          kind: 'rebuilt',
          ns: 'llm-pi-ai',
          addedModels: ['cn:brand-new'],
          keptModels: 46,
          offeredModels: ['cn:brand-new', 'cn:m0'],
          notes: [],
        }
      },
    }))
    const body = await api.action({ action: 'rebuild' })
    expect(calls).toBe(1)
    expect(body).toMatchObject({
      ok: true,
      addedModels: 1,
      addedModelIds: ['cn:brand-new'],
      keptModels: 46,
      offeredModels: 2,
      holdReason: null,
      // 兼容别名（卡片侧 lib/client.js 读的就是这几个名字）。
      added: ['cn:brand-new'],
      addedCount: 1,
      keptCount: 46,
      offeredCount: 2,
      modelCount: 47,
    })
    expect(String(body['detail'])).toContain('保留 46 个，新增 1 个')
    // rebuild 这个动作本身**不**替面板读网关（数据面归 panel）。
    expect(gateway.calls).toHaveLength(0)
  })

  it('没有墓碑记录（holdReason）⇒ 如实说"一个都没加"，不谎报成功新增', async () => {
    const gateway = fakeGateway()
    const body = await createPanelApi(makeDeps(gateway, {
      rebuild: async () => ({
        kind: 'rebuilt',
        ns: 'llm-pi-ai',
        addedModels: [],
        keptModels: 10,
        offeredModels: ['cn:m0'],
        holdReason: '没有上一次的墓碑记录，无法区分"网关新增"与"你删掉的"',
        notes: [],
      }),
    })).action({ action: 'rebuild' })
    expect(body.ok).toBe(true)
    expect(body.addedModels).toBe(0)
    expect(String(body.holdReason)).toContain('墓碑')
    expect(String(body.detail)).toContain('未刷新')
  })

  it('写入失败 / 回滚 ⇒ ok:false 且 detail 说清是哪一种', async () => {
    const gateway = fakeGateway()
    const failed = await createPanelApi(makeDeps(gateway, {
      rebuild: async () => ({ kind: 'failed', reason: 'gateway-unreachable', detail: 'GET /v1/models 返回 HTTP 502', notes: [] }),
    })).action({ action: 'rebuild' })
    expect(failed.ok).toBe(false)
    expect(String(failed.detail)).toContain('gateway-unreachable')

    const rolledBack = await createPanelApi(makeDeps(gateway, {
      rebuild: async () => ({
        kind: 'rolled-back',
        ns: 'llm-pi-ai',
        reasons: ['模型数从 46 掉到 0'],
        backupPath: 'C:/backups/x.yml',
        recovery: 'ok',
        manualBlock: '',
        notes: [],
      }),
    })).action({ action: 'rebuild' })
    expect(rolledBack.ok).toBe(false)
    expect(String(rolledBack.detail)).toContain('已回滚')
  })

  it('rebuild 自己抛错 ⇒ 折成 ok:false，不把路由带崩', async () => {
    const gateway = fakeGateway()
    const body = await createPanelApi(makeDeps(gateway, {
      rebuild: async () => { throw new Error('boom') },
    })).action({ action: 'rebuild' })
    expect(body).toEqual({ ok: false, detail: 'action rebuild 失败：boom' })
  })
})

/* ── action：rebuild + reset（完全重建）────────────────────────────────────── */

describe('POST <prefix>/action { action: "rebuild", reset: true } —— 完全重建', () => {
  /** 一次完全重建的典型结果：原来 6 个手写模型 → 网关目录 48 个。 */
  const resetOutcome = {
    kind: 'reset' as const,
    ns: 'llm-pi-ai',
    keptModels: 6,
    writtenModels: ['cn:hy3', 'cn:hy4', 'cn:text-only'],
    addedModels: ['cn:hy4', 'cn:text-only'],
    droppedModels: ['cn:hand-written-1', 'cn:hand-written-2', 'cn:hand-written-3'],
    offeredModels: ['cn:hy3', 'cn:hy4', 'cn:text-only'],
    backupPath: 'C:/backups/x.yml',
    notes: [],
  }

  it('★ reset:true 走**另一条**路径（resetRebuild），不是只增不删那条', async () => {
    const gateway = fakeGateway()
    let rebuilt = 0
    let reset = 0
    const body = await createPanelApi(makeDeps(gateway, {
      rebuild: async () => { rebuilt += 1; throw new Error('不该走到只增不删那条路') },
      resetRebuild: async () => { reset += 1; return resetOutcome },
    })).action({ action: 'rebuild', reset: true })
    expect(reset).toBe(1)
    expect(rebuilt).toBe(0)
    expect(body.ok).toBe(true)
    expect(body.detail).toContain('整份覆盖')
  })

  it('★ 丢掉的 id 必须点名报出来（0.4.0 的承诺）', async () => {
    const body = await createPanelApi(makeDeps(fakeGateway(), {
      resetRebuild: async () => resetOutcome,
    })).action({ action: 'rebuild', reset: true })
    expect(body).toMatchObject({
      written: ['cn:hy3', 'cn:hy4', 'cn:text-only'],
      writtenCount: 3,
      writtenModels: 3,
      writtenModelIds: ['cn:hy3', 'cn:hy4', 'cn:text-only'],
      addedCount: 2,
      droppedCount: 3,
      dropped: ['cn:hand-written-1', 'cn:hand-written-2', 'cn:hand-written-3'],
      droppedModels: 3,
      droppedModelIds: ['cn:hand-written-1', 'cn:hand-written-2', 'cn:hand-written-3'],
      modelCount: 3,
    })
    expect(String(body.detail)).toContain('丢掉 3 个')
  })

  it('🔴 不带 reset ⇒ 走的仍是只增不删那条路（默认行为一个字不变）', async () => {
    const gateway = fakeGateway()
    let rebuilt = 0
    let reset = 0
    const body = await createPanelApi(makeDeps(gateway, {
      rebuild: async () => {
        rebuilt += 1
        return { kind: 'rebuilt', ns: 'llm-pi-ai', addedModels: [], keptModels: 6, offeredModels: [], notes: [] }
      },
      resetRebuild: async () => { reset += 1; return resetOutcome },
    })).action({ action: 'rebuild' })
    expect(rebuilt).toBe(1)
    expect(reset).toBe(0)
    // 只增不删的回执里**不应该**出现 dropped/written 这些覆盖语义的字段。
    expect(body.dropped).toBeUndefined()
    expect(body.written).toBeUndefined()
  })

  it('reset 之外的假值（reset:false / "true" / 1）都不触发覆盖', async () => {
    for (const value of [false, 'true', 1, null, undefined]) {
      let reset = 0
      await createPanelApi(makeDeps(fakeGateway(), {
        rebuild: async () => ({ kind: 'rebuilt', ns: 'llm-pi-ai', addedModels: [], keptModels: 6, offeredModels: [], notes: [] }),
        resetRebuild: async () => { reset += 1; return resetOutcome },
      })).action({ action: 'rebuild', reset: value })
      expect(reset).toBe(0)
    }
  })

  it('完全重建失败 / 被回滚 ⇒ ok:false，且 detail 说清是哪一种', async () => {
    const failed = await createPanelApi(makeDeps(fakeGateway(), {
      resetRebuild: async () => ({ kind: 'failed', reason: 'write-failed', detail: '磁盘只读', notes: [] }),
    })).action({ action: 'rebuild', reset: true })
    expect(failed.ok).toBe(false)
    expect(String(failed.detail)).toContain('磁盘只读')
    const rolledBack = await createPanelApi(makeDeps(fakeGateway(), {
      resetRebuild: async () => ({
        kind: 'rolled-back',
        ns: 'llm-pi-ai',
        reasons: ['模型数从 48 掉到 0'],
        backupPath: 'C:/backups/x.yml',
        recovery: '已盖回',
        manualBlock: '',
        notes: [],
      }),
    })).action({ action: 'rebuild', reset: true })
    expect(rolledBack.ok).toBe(false)
    expect(String(rolledBack.detail)).toContain('已回滚')
  })
})

/* ── action：checkin ─────────────────────────────────────────────────────── */

describe('POST <prefix>/action { action: "checkin" }', () => {
  it('★ 只有被调用才发请求 —— panel 一次都不会触发它', async () => {
    const gateway = fakeGateway()
    let checkins = 0
    const base = makeDeps(gateway, {
      checkin: async () => {
        checkins += 1
        return { attempted: true, ok: true, status: 'ok', detail: '成功 {"credit":50}' }
      },
    })
    const api = createPanelApi(base)

    // 反复读面板（模拟卡片刷新）—— 签到调用次数必须始终是 0。
    await api.panel()
    await api.panel()
    expect(checkins).toBe(0)

    const body = await api.action({ action: 'checkin' })
    expect(checkins).toBe(1)
    expect(body).toEqual({ ok: true, attempted: true, status: 'ok', already: false, detail: '成功 {"credit":50}' })
  })

  it('★「今天已签到」⇒ ok:true + status:already + already:true（卡片显示 ✅，不是 ❌）', async () => {
    const body = await createPanelApi(makeDeps(fakeGateway(), {
      checkin: async () => ({
        attempted: true,
        ok: true,
        status: 'already',
        detail: '今天已签过（幂等成功，本次没有新增签到）：上游说「今天已签到，请明天再来」',
      }),
    })).action({ action: 'checkin' })
    expect(body).toMatchObject({ ok: true, attempted: true, status: 'already', already: true })
    expect(String(body.detail)).toContain('幂等成功')
  })

  it('没有 CN 账号 ⇒ attempted:false（一个上游请求都不会发）', async () => {
    const gateway = fakeGateway()
    const body = await createPanelApi(makeDeps(gateway, {
      checkin: async () => ({ attempted: false, ok: false, status: 'not-attempted', detail: '没有启用的 CN 账号 —— 未发请求' }),
    })).action({ action: 'checkin' })
    expect(body).toMatchObject({ ok: false, attempted: false, status: 'not-attempted', already: false })
  })

  it('pickCheckinAccount 只认**启用**的 CN 账号', () => {
    expect(pickCheckinAccount(ACCOUNTS)?.uid).toBe('oneid_186')
    expect(pickCheckinAccount([])).toBeUndefined()
    expect(pickCheckinAccount([{ ...ACCOUNTS[0]!, enabled: false }])).toBeUndefined()
    expect(pickCheckinAccount([{ ...ACCOUNTS[0]!, realm: 'global' }])).toBeUndefined()
  })

  it('★ 抽取出来的 requestDailyCheckin：**被调用才发请求**，且只发一次', async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = []
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string> })
      return new Response(JSON.stringify({ code: 0, data: { credit: 50 } }), { status: 200 })
    }
    // 构造但不调用 ⇒ 一个请求都没有（"没有隐式调用"这条在这里是可证的）。
    const credential = { accessToken: 'tok', domain: 'copilot.tencent.com' }
    const identity = { uid: 'oneid_186', enterpriseId: 'ent-1' }
    expect(calls).toHaveLength(0)

    const outcome = await requestDailyCheckin({ realm: 'cn', credential, identity, fetchImpl })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://www.codebuddy.cn/v2/billing/meter/daily-checkin')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.headers['Authorization']).toBe('Bearer tok')
    expect(calls[0]?.headers['X-User-Id']).toBe('oneid_186')
    expect(outcome).toMatchObject({ attempted: true, ok: true })
  })

  it('global ⇒ attempted:false，一个请求都不发（上游只实测了 CN）', async () => {
    let sent = 0
    const outcome = await requestDailyCheckin({
      realm: 'global',
      credential: { accessToken: 'tok', domain: 'www.workbuddy.ai' },
      identity: { uid: 'u', enterpriseId: '' },
      fetchImpl: async () => { sent += 1; return new Response('{}') },
    })
    expect(sent).toBe(0)
    expect(outcome.attempted).toBe(false)
  })

  it('上游拒绝（真失败）⇒ attempted:true + ok:false + status:failed，且不抛', async () => {
    const outcome = await requestDailyCheckin({
      realm: 'cn',
      credential: { accessToken: 'tok', domain: 'copilot.tencent.com' },
      identity: { uid: 'u', enterpriseId: '' },
      fetchImpl: async () => new Response(JSON.stringify({ code: 50001, msg: '系统繁忙' }), { status: 500 }),
    })
    expect(outcome).toEqual({ attempted: true, ok: false, status: 'failed', detail: '系统繁忙' })
  })

  it('★「今天已签到」（真机实录 HTTP 400 + code 10001）⇒ ok:true + status:already', async () => {
    const outcome = await requestDailyCheckin({
      realm: 'cn',
      credential: { accessToken: 'tok', domain: 'copilot.tencent.com' },
      identity: { uid: 'u', enterpriseId: '' },
      fetchImpl: async () => new Response(JSON.stringify({ code: 10001, msg: '今天已签到，请明天再来' }), { status: 400 }),
    })
    expect(outcome).toMatchObject({ attempted: true, ok: true, status: 'already' })
    expect(outcome.detail).toContain('幂等成功')
  })

  it('renderCheckinTrace：三态与 detail 都落进那一行（2026-10-15 缺的就是它）', () => {
    const line = renderCheckinTrace('cn', {
      attempted: true,
      ok: true,
      status: 'already',
      detail: '今天已签过（幂等成功，本次没有新增签到）：上游说「今天已签到，请明天再来」',
    })
    expect(line).toBe(
      'api: checkin realm=cn attempted=true ok=true status=already '
      + 'detail=今天已签过（幂等成功，本次没有新增签到）：上游说「今天已签到，请明天再来」',
    )
    // 真失败也要能一眼分辨：status 不同、detail 是上游原话。
    expect(renderCheckinTrace('cn', { attempted: true, ok: false, status: 'failed', detail: '系统繁忙' }))
      .toContain('status=failed detail=系统繁忙')
    // 换行会被压成空格（这一行必须能被逐行读取）。
    expect(renderCheckinTrace('cn', { attempted: true, ok: false, status: 'failed', detail: 'a\nb' }))
      .toContain('detail=a b')
    // 「根本没发」也说得清清楚楚。
    expect(renderCheckinTrace('global', { attempted: false, ok: false, status: 'not-attempted', detail: '没有签到端点' }))
      .toContain('attempted=false ok=false status=not-attempted')
  })

  it('readAuthFile：缺 uid / 缺 accessToken / 不是 JSON ⇒ undefined（不拿半份凭证去签到）', () => {
    expect(readAuthFile(join(tmpdir(), `no-such-file-${String(Date.now())}.json`))).toBeUndefined()
    const dir = mkdtempSync(join(tmpdir(), 'wb2a-auth-'))
    try {
      const good = join(dir, 'good.json')
      writeFileSync(good, JSON.stringify({
        account: { uid: 'oneid_186', enterpriseId: 'ent-1', nickname: PHONE },
        auth: { accessToken: 'tok', refreshToken: 'r', expiresAt: 1, domain: 'copilot.tencent.com', realm: 'cn' },
      }), 'utf8')
      expect(readAuthFile(good)?.account.uid).toBe('oneid_186')

      const noToken = join(dir, 'no-token.json')
      writeFileSync(noToken, JSON.stringify({ account: { uid: 'u' }, auth: {} }), 'utf8')
      expect(readAuthFile(noToken)).toBeUndefined()

      const broken = join(dir, 'broken.json')
      writeFileSync(broken, '{ not json', 'utf8')
      expect(readAuthFile(broken)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/* ── action：test ────────────────────────────────────────────────────────── */

describe('POST <prefix>/action { action: "test" } —— 唯一会花额度的动作', () => {
  it('★ 不带 confirm ⇒ 拒绝，且一个请求都不发', async () => {
    const gateway = fakeGateway()
    const body = await createPanelApi(makeDeps(gateway)).action({ action: 'test' })
    expect(body.ok).toBe(false)
    expect(body.attempted).toBe(false)
    expect(String(body.detail)).toContain('confirm')
    expect(gateway.calls).toHaveLength(0)

    // 显式 false / 字符串 "true" 同样不算确认（避免前端传错类型就花钱）。
    const gateway2 = fakeGateway()
    await createPanelApi(makeDeps(gateway2)).action({ action: 'test', confirm: false })
    await createPanelApi(makeDeps(gateway2)).action({ action: 'test', confirm: 'true' })
    expect(gateway2.calls).toHaveLength(0)
  })

  it('带 confirm ⇒ 自动选 x0.00 免费档，并报**实测**花费（前后各读一次 /v1/stats）', async () => {
    const gateway = fakeGateway()
    // /v1/stats 每次返回不同的 credit（100 → 100.5），差值就是「这次花了多少」。
    const credits = [100, 100.5]
    let statsReads = 0
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      if (!String(input).endsWith('/v1/stats')) return await gateway.fetchImpl(input, init)
      const credit = credits[Math.min(statsReads, credits.length - 1)]
      statsReads += 1
      gateway.calls.push({ url: String(input), method: init?.method ?? 'GET', headers: {} })
      return new Response(
        JSON.stringify({ enabled: true, since: 's', uptime_sec: 10, total: { requests: 1, credit }, models: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const body = await createPanelApi(makeDeps(gateway, { fetchImpl })).action({ action: 'test', confirm: true })
    expect(body).toMatchObject({ ok: true, attempted: true })
    expect(statsReads).toBe(2)
    expect(body.ok).toBe(true)
    expect(body.attempted).toBe(true)
    // 目录里前 5 条是 x0.00 ⇒ 没指定模型时选第一条。
    expect(body.model).toBe('cn:m0')
    expect(body.creditBefore).toBe(100)
    expect(body.creditAfter).toBe(100.5)
    expect(body.creditSpent).toBe(0.5)
    expect(body.content).toBe('可以')
    // 卡片逐行渲染读的是 results[]（`id · verdict`）。
    const results = body.results as Array<Record<string, unknown>>
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ id: 'cn:m0', model: 'cn:m0', ok: true })
    expect(String(results[0]?.['verdict'])).toContain('实际花费 0.5')

    const chat = gateway.calls.find(call => call.url.endsWith('/chat/completions'))
    expect(chat?.method).toBe('POST')
    const sent = JSON.parse(chat?.body ?? '{}') as { model?: string; max_tokens?: number; stream?: boolean }
    expect(sent.model).toBe('cn:m0')
    expect(sent.max_tokens).toBe(16)
    expect(sent.stream).toBe(false)
  })

  it('目录里没有免费档且未指定 model ⇒ 拒绝（绝不替用户挑一个收费模型）', async () => {
    const gateway = fakeGateway({ models: { object: 'list', data: [{ id: 'cn:paid', credits: 'x9.99' }] } })
    const body = await createPanelApi(makeDeps(gateway)).action({ action: 'test', confirm: true })
    expect(body.ok).toBe(false)
    expect(body.attempted).toBe(false)
    expect(String(body.detail)).toContain('拒绝替你挑一个收费模型')
    expect(gateway.calls.some(call => call.url.includes('/chat/completions'))).toBe(false)
  })

  it('显式指定模型 ⇒ 尊重，但把"单价未知/要花钱"写进 note', async () => {
    const gateway = fakeGateway()
    const body = await createPanelApi(makeDeps(gateway)).action({ action: 'test', confirm: true, model: 'cn:unknown-price' })
    expect(body.ok).toBe(true)
    expect(body.model).toBe('cn:unknown-price')
    expect(String(body.note)).toContain('单价未知')
  })

  it('上游报错 ⇒ ok:false 但 attempted:true（"发了但失败"与"根本没发"必须能分开）', async () => {
    const gateway = fakeGateway({ chatStatus: 500, chatBody: { error: { message: 'upstream boom' } } })
    const body = await createPanelApi(makeDeps(gateway)).action({ action: 'test', confirm: true })
    expect(body.ok).toBe(false)
    expect(body.attempted).toBe(true)
    expect(String(body.detail)).toContain('HTTP 500')
  })
})

describe('POST <prefix>/action —— 未知动作', () => {
  it('缺 action / 未知 action ⇒ ok:false 且点名支持哪些', async () => {
    const api = createPanelApi(makeDeps(fakeGateway()))
    const missing = await api.action({})
    expect(missing.ok).toBe(false)
    expect(String(missing.detail)).toContain('缺少 action')
    const unknown = await api.action({ action: 'drop-database' })
    expect(String(unknown.detail)).toContain('未知 action')
    expect(String(unknown.detail)).toContain('rebuild / checkin / test')
  })
})

/* ── 路由层：注册 / 反注册 / 双前缀 ──────────────────────────────────────── */

/** 假 webServer：与 `dsh-host-webserver` 一样，**重复的 (kind, path) 会抛**。 */
function fakeHost(): {
  webServer: { register: (route: { kind: string; path: string; handler: unknown }) => () => void }
  routes: Array<{ kind: string; path: string; handler: unknown }>
} {
  const table = new Map<string, unknown>()
  const routes: Array<{ kind: string; path: string; handler: unknown }> = []
  return {
    routes,
    webServer: {
      register(route) {
        const key = `${route.kind}:${route.path}`
        if (table.has(key)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        table.set(key, route)
        routes.push(route)
        return () => {
        table.delete(key)
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
      },
    },
  }
}

interface FakeCtx {
  ctx: PanelRouteContext
  effects: Array<() => void>
}

/**
 * 替身 ctx：`inject` 立刻用子 ctx 调回调（真实 cordis 在依赖齐备时也是这个时机），
 * `effect` 把 disposer 收起来 —— 于是"重跑 inject"与"反注册"都能被断言。
 */
function fakeCtx(options: {
  host?: ReturnType<typeof fakeHost>
  requestRejection?: (req: unknown) => number | undefined
  viaGetter?: boolean
  withEffect?: boolean
  /** 记下 `inject` 收到的依赖数组（断言"必须连 connection 一起 inject"）。 */
  seen?: string[][]
}): FakeCtx {
  const host = options.host ?? fakeHost()
  const effects: Array<() => void> = []
  const child: Record<string, unknown> = {
    connection: { requestRejection: options.requestRejection ?? ((): undefined => undefined) },
    webServer: host.webServer,
    effect: (execute: () => () => void) => { effects.push(execute()) },
  }
  if (options.viaGetter === true) {
    // 属性读不到、但 ctx.get() 读得到 —— 宿主自己的插件两种读法都写了，两种都要能用。
    child['connection'] = undefined
    child['webServer'] = undefined
    child['get'] = (name: string) => (name === 'connection'
      ? { requestRejection: options.requestRejection ?? ((): undefined => undefined) }
      : host.webServer)
  }
  if (options.withEffect === false) delete child['effect']

  const ctx: PanelRouteContext = {
    inject: (deps, callback) => {
      options.seen?.push(deps)
      callback(child)
      return {}
    },
  }
  return { ctx, effects }
}

const stubApi: PanelApi = {
  panel: async () => ({
    ok: true,
    gateway: { reachable: true, origin: 'http://127.0.0.1:7863', healthy: 1, total: 1 },
    credits: null,
    models: { gatewayTotal: 1, unknownPrice: 0, providerModelCount: 1 },
    provider: { exists: true, ns: 'llm-pi-ai', lastOffered: 1 },
    usage: null,
    checkin: { supported: true, note: 'n' },
  }),
  action: async () => ({ ok: true }),
}

describe('路由注册：两条前缀 + 配对反注册', () => {
  it('★ 连 connection 一起 inject，并在两条前缀上各挂一次', () => {
    const host = fakeHost()
    const seen: string[][] = []
    const fake = fakeCtx({ host, seen })
    const traces: string[] = []
    registerPanelRoutes(fake.ctx, { api: stubApi, trace: line => traces.push(line) })

    // ① 只 inject webServer 会拿不到栅栏 —— 必须两个都要。
    expect(seen).toEqual([['connection', 'webServer']])
    // ② 双前缀，都是 prefix 路由。
    expect(host.routes.map(route => route.path)).toEqual(['/wb2api', '/api/wb2api'])
    expect(host.routes.every(route => route.kind === 'prefix')).toBe(true)
    expect(host.routes.every(route => typeof route.handler === 'function')).toBe(true)
    expect(ROUTE_PATHS).toEqual(['/wb2api', '/api/wb2api'])
    expect(traces.some(line => line.includes('已注册') && line.includes('/api/wb2api'))).toBe(true)
  })

  it('★ inject 回调重跑：不反注册会撞"重复注册"，反注册之后就没事', () => {
    const host = fakeHost()
    const fake = fakeCtx({ host })
    const traces: string[] = []
    registerPanelRoutes(fake.ctx, { api: stubApi, trace: line => traces.push(line) })
    expect(host.routes).toHaveLength(2)

    // 重跑（connection/webServer 被替换、热重载）而**没有**先反注册：
    // 真实 webServer 会对重复的 (kind,path) 抛错 —— 这里由假 webServer 复现。
    registerPanelRoutes(fake.ctx, { api: stubApi, trace: line => traces.push(line) })
    expect(traces.filter(line => line.includes('注册失败')).length).toBe(2)
    expect(host.routes).toHaveLength(2) // 仍是第一次那两条，没有挂重

    // 反注册（ctx.effect 里那个 disposer）之后重跑 ⇒ 干净地挂上。
    expect(fake.effects).toHaveLength(1)
    for (const dispose of fake.effects.splice(0)) dispose()
    expect(host.routes).toHaveLength(0)
    registerPanelRoutes(fake.ctx, { api: stubApi, trace: line => traces.push(line) })
    expect(host.routes).toHaveLength(2)
  })

  it('栅栏不可用 ⇒ 一条都不挂（「没有路由」优于「没有栅栏的路由」）', () => {
    const host = fakeHost()
    // connection 存在但拿不到 requestRejection。
    const ctx: PanelRouteContext = {
      inject: (_deps, callback) => {
        callback({ webServer: host.webServer, effect: () => undefined })
        return {}
      },
    }
    const traces: string[] = []
    registerPanelRoutes(ctx, { api: stubApi, trace: line => traces.push(line) })
    expect(host.routes).toHaveLength(0)
    expect(traces.some(line => line.includes('未注册'))).toBe(true)
  })

  it('属性读不到时回退到 ctx.get(name)（宿主自己的插件两种读法都写了）', () => {
    const host = fakeHost()
    const fake = fakeCtx({ host, viaGetter: true })
    registerPanelRoutes(fake.ctx, { api: stubApi, trace: () => undefined })
    expect(host.routes.map(route => route.path)).toEqual(['/wb2api', '/api/wb2api'])
  })

  it('拿不到 ctx.effect ⇒ 把刚挂上的路由撤掉（撤不掉的路由会在重跑时抛）', () => {
    const host = fakeHost()
    const fake = fakeCtx({ host, withEffect: false })
    const traces: string[] = []
    registerPanelRoutes(fake.ctx, { api: stubApi, trace: line => traces.push(line) })
    expect(host.routes).toHaveLength(0)
    expect(traces.some(line => line.includes('ctx.effect 不可用'))).toBe(true)
  })

  it('★ 栅栏必须以**方法形式**调用（`this` 必须是 connection 自己）', async () => {
    // 真机上把 `requestRejection` 摘成裸函数再调，`this` 会落到一个没有 `browserAuth`
    // 的影子上，实测抛 `Cannot read properties of undefined (reading 'isAuthenticated')` ——
    // 于是栅栏永远 403，浏览器会话那一半根本没跑。这条测试就是钉住这个调用形式。
    const host = fakeHost()
    const receivers: Array<unknown> = []
    const connection = {
      requestRejection(this: unknown): number | undefined {
        receivers.push(this)
        return undefined
      },
    }
    const ctx: PanelRouteContext = {
      inject: (_deps, callback) => {
        callback({ connection, webServer: host.webServer, effect: () => undefined })
        return {}
      },
    }
    registerPanelRoutes(ctx, { api: stubApi, trace: () => undefined })
    const handler = host.routes[0]?.handler as (req: unknown, res: unknown) => Promise<void>

    const res = { writeHead: (): void => undefined, end: (): void => undefined }
    await handler({ method: 'GET', url: '/wb2api/panel', headers: { host: '127.0.0.1:19387' } }, res)
    expect(receivers).toEqual([connection])
  })
})

/* ── 路由层：前缀剥离 ────────────────────────────────────────────────────── */

describe('前缀剥离', () => {
  it('两条前缀都剥，`/api` 只在后面确实是我们的路径时才剥', () => {
    expect(stripRoutePrefix('/wb2api/panel')).toBe('/panel')
    expect(stripRoutePrefix('/api/wb2api/panel')).toBe('/panel')
    expect(stripRoutePrefix('/wb2api')).toBe('')
    expect(stripRoutePrefix('/api/wb2api')).toBe('')
    expect(stripRoutePrefix('/wb2api/action')).toBe('/action')
    // 不是我们的路径：一个字符都不动（否则会把别人的请求接到我们头上）。
    expect(stripRoutePrefix('/api/other')).toBe('/api/other')
    expect(stripRoutePrefix('/api/wb2apix/panel')).toBe('/api/wb2apix/panel')
    expect(stripRoutePrefix('/wb2apix/panel')).toBe('/wb2apix/panel')
    expect(stripRoutePrefix('/')).toBe('/')
  })

  it('端口跳转例外只放宽"两边都是回环"（与兄弟插件逐字同一口径）', () => {
    const req = (headers: Record<string, string>): unknown => ({ headers })
    expect(isLoopbackPortHop(req({ host: '127.0.0.1:9728', origin: 'http://127.0.0.1:19387' }))).toBe(true)
    expect(isLoopbackPortHop(req({ host: '127.0.0.1:9728' }))).toBe(true)
    expect(isLoopbackPortHop(req({ host: 'localhost:9728', origin: 'http://localhost:1' }))).toBe(true)
    // 非回环 Host / Origin：**绝不放宽**（挡的是外部网页来打本机端口）。
    expect(isLoopbackPortHop(req({ host: 'evil.example.com', origin: 'http://evil.example.com' }))).toBe(false)
    expect(isLoopbackPortHop(req({ host: '0.0.0.0:9728' }))).toBe(false)
    expect(isLoopbackPortHop(req({ host: '127.0.0.1:9728', origin: 'file://' }))).toBe(false)
    expect(isLoopbackPortHop(req({ host: '127.0.0.1:9728', origin: 'https://evil.example.com' }))).toBe(false)
    expect(isLoopbackPortHop(req({}))).toBe(false)
  })
})

/* ── 路由层：真 HTTP 驱动 handler ────────────────────────────────────────── */

/** 用一个真 HTTP server 驱动 handler（`req`/`res` 是真的 Node 对象）。 */
async function withServer(run: (base: string) => Promise<void>, options: {
  requestRejection?: (req: unknown) => number | undefined
  api?: PanelApi
  traces?: string[]
} = {}): Promise<void> {
  const api = options.api ?? stubApi
  const handler = createHostRouteHandler({
    requestRejection: options.requestRejection ?? ((): undefined => undefined),
    api,
    trace: line => options.traces?.push(line),
  })
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => resolve()) })
  const port = (server.address() as AddressInfo).port
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  }
}

describe('路由 handler（真 http 驱动）', () => {
  it('★ 两条前缀都能通，且回的是同一份 JSON', async () => {
    await withServer(async (base) => {
      const bare = await fetch(`${base}/wb2api/panel`)
      const viaApi = await fetch(`${base}/api/wb2api/panel`)
      expect(bare.status).toBe(200)
      expect(viaApi.status).toBe(200)
      expect(bare.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(bare.headers.get('cache-control')).toBe('no-store')
      const bareBody = await bare.json() as Record<string, unknown>
      expect(bareBody['ok']).toBe(true)
      expect(bareBody).toEqual(await viaApi.json())
    })
  })

  it('POST /action 解析 JSON 请求体；两条前缀同样等价', async () => {
    const seen: unknown[] = []
    const api: PanelApi = { panel: stubApi.panel, action: async (body) => { seen.push(body); return { ok: true, echoed: body } } }
    await withServer(async (base) => {
      for (const prefix of ['/wb2api', '/api/wb2api']) {
        const response = await fetch(`${base}${prefix}/action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'rebuild' }),
        })
        expect(response.status).toBe(200)
      }
    }, { api })
    expect(seen).toEqual([{ action: 'rebuild' }, { action: 'rebuild' }])
  })

  it('请求体不是 JSON ⇒ 200 + ok:false（与兄弟插件同一口径，不是 400）', async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/wb2api/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      })
      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, unknown>
      expect(body['ok']).toBe(false)
      expect(String(body['detail'])).toContain('不是合法 JSON')
    })
  })

  it('超大请求体 ⇒ 200 + ok:false（上限 64KB）', async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/wb2api/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'rebuild', pad: 'x'.repeat(70 * 1024) }),
      })
      const body = await response.json() as Record<string, unknown>
      expect(body['ok']).toBe(false)
      expect(String(body['detail'])).toContain('过大')
    })
  })

  it('未知端点 / 方法不符 ⇒ 明确的 404 / 405（不是空白 500）', async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}/wb2api/nope`)).status).toBe(404)
      expect((await fetch(`${base}/api/other`)).status).toBe(404)
      expect((await fetch(`${base}/wb2api/panel`, { method: 'POST' })).status).toBe(405)
      expect((await fetch(`${base}/wb2api/action`)).status).toBe(405)
    })
  })

  it('★ 栅栏拒了就拒：401 / 403 回纯文本，端点一次都没被调用', async () => {
    let called = 0
    const api: PanelApi = {
      panel: async () => { called += 1; return await stubApi.panel() },
      action: async () => { called += 1; return { ok: true } },
    }
    // ① 401 = 「你不是操作者」（浏览器会话缺失/过期）—— 永远不放宽。
    await withServer(async (base) => {
      const unauthorized = await fetch(`${base}/wb2api/panel`)
      expect(unauthorized.status).toBe(401)
      expect(await unauthorized.text()).toBe('unauthorized')
    }, { api, requestRejection: () => 401 })
    expect(called).toBe(0)

    // ② 403 = 来源不可信。带一个**非回环 Origin** ⇒ 端口跳转例外不适用，必须 403。
    await withServer(async (base) => {
      const forbidden = await fetch(`${base}/api/wb2api/panel`, { headers: { origin: 'http://evil.example.com' } })
      expect(forbidden.status).toBe(403)
      expect(await forbidden.text()).toBe('forbidden')
    }, { api, requestRejection: () => 403 })
    expect(called).toBe(0)
  })

  it('★ 回环端口跳变的 403 被容忍（否则桌面 app 代理下卡片全 403）', async () => {
    const traces: string[] = []
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/wb2api/panel`)
      expect(response.status).toBe(200)
      expect((await response.json() as Record<string, unknown>)['ok']).toBe(true)
    }, {
      // 栅栏对回环也判 403（实测行为）——请求头里 Host 与 Origin 都是回环。
      requestRejection: () => 403,
      traces,
    })
    // 注意：fetch 到 127.0.0.1 时 Host 是回环，且不带 Origin ⇒ 命中例外。
    expect(traces.some(line => line.includes('回环端口跳转'))).toBe(true)
  })

  it('端点自己抛错 ⇒ 折成 200 + ok:false，不变成无正文的 500', async () => {
    const api: PanelApi = {
      panel: async () => { throw new Error('端点是故意的') },
      action: async () => ({ ok: true }),
    }
    await withServer(async (base) => {
      const response = await fetch(`${base}/wb2api/panel`)
      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, unknown>
      expect(body).toEqual({ ok: false, detail: '端点是故意的' })
    }, { api })
  })
})
