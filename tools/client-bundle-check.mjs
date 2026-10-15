/**
 * Verify the BROWSER half of dsh-workbuddy2api WITHOUT a browser (condensed C2 gate).
 *
 * This is an OFFLINE gate. It never performs a real request (the stub `fetch` would
 * throw before one left), and it drives the SHIPPED code — `exports.__internals` —
 * rather than a copy of it. In order:
 *
 *   [1] `lib/client.js` parses as a CLASSIC script (that is how the page loads it):
 *       no ES-module statement, no TypeScript-only syntax.
 *   [2] `window.__ModuleLoader__.load()` is called exactly ONCE with
 *       `id === package.json name`, `dsh.client.platform === "web"`, and
 *       `exports["./client"].default` pointing at this very file.
 *   [3] The factory resolves with PLATFORM SEED WORDS only (nothing outside
 *       `dsh.client.inject` may be required), and the plugin face is what the client
 *       loader reads: `apply` (function) + `inject === ["slots"]`.
 *   [4] BOTH settings seats and all four keys are registered, priority 30, one
 *       `try` per seat (a slot this host build lacks must not cost us the other).
 *   [5] NO CREDENTIAL is embedded: no bearer/token literal, no cookie or
 *       localStorage/sessionStorage use, no credential file path.
 *   [6] The double-prefix contract holds BEHAVIOURALLY, not by grepping the source:
 *       a non-JSON answer moves to the second prefix and the winner is remembered;
 *       a business refusal `{ok:false}` is a NORMAL answer and does NOT cost a
 *       second request; the failure sentence names each path with its own status.
 *   [7] The card RENDERS all four states (loading / error / empty / ready) with the
 *       server's own words on screen, and never a bare `undefined`/`NaN`.
 *   [8] The dangerous buttons are gated: none fires on mount, 签到 fires only from a
 *       click, 重建清单 explains "只增不删" in its confirm and sends nothing when
 *       declined, 完全重建 (the DESTRUCTIVE one) states its cost in its own label and
 *       in its confirm, sends `{action:"rebuild", reset:true}` only after acceptance
 *       and lists the dropped ids — and 测试模型 refuses to request without an explicit
 *       confirmation and then sends `confirm: true`.
 *   [9] The pure formatters survive degenerate input (the "server answered something
 *       unexpected" paths) without throwing or printing a ghost.
 *  [10] The `panel` shape from the contract produces exactly the figures the user
 *       asked to see (per-account rows, `usage.since`, `provider.lastOffered` next
 *       to `models.providerModelCount`).
 *
 * Run:  <dsh-node> tools/client-bundle-check.mjs
 * Exit: 0 = PASS, 1 = FAIL
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const MANIFEST = join(ROOT, 'package.json')

let checks = 0
let failures = 0
const section = (title) => console.log(`\n${title}`)
const ok = (label, detail = '') => {
  checks += 1
  console.log(`  ok   ${label}${detail ? `  ${detail}` : ''}`)
}
const bad = (label, detail = '') => {
  checks += 1
  failures += 1
  console.log(`  FAIL ${label}${detail ? `  ${detail}` : ''}`)
}
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) ok(label, `= ${a}`)
  else bad(label, `expected ${e}, got ${a}`)
}
const truthy = (label, value, detail = '') => {
  if (value) ok(label, detail)
  else bad(label, `got ${JSON.stringify(value)}`)
}
const has = (label, haystack, needle) => {
  if (typeof haystack === 'string' && haystack.includes(needle)) ok(label, `contains ${JSON.stringify(needle)}`)
  else bad(label, `missing ${JSON.stringify(needle)}`)
}
const absent = (label, haystack, needle) => {
  if (typeof haystack === 'string' && !haystack.includes(needle)) ok(label, `no ${JSON.stringify(needle)}`)
  else bad(label, `unexpected ${JSON.stringify(needle)}`)
}
/** A source file is a classic script: no line may START with an ES statement. */
const esStatement = (source) => /(^|\n)\s*(import|export)\s/.exec(source)

/* ────────────────── [1] parse as a classic script ────────────────── */
section('[1] lib/client.js parses as a classic script')
if (!existsSync(BUNDLE)) {
  // Exit 2 is this suite's "I did not run" sentinel: tools/_run-suites.mjs turns it into
  // a named SKIP. A missing bundle is "not run", never "passed" (see that file's rule ①).
  console.log(`SKIP  ${BUNDLE} 不存在 —— 浏览器半边还没落地？`)
  process.exit(2)
}
const source = readFileSync(BUNDLE, 'utf8')
const bytes = statSync(BUNDLE).size
try {
  new vm.Script(source, { filename: BUNDLE })
  ok('new vm.Script(source) — classic-script parse', `${source.split('\n').length} lines / ${bytes} bytes`)
} catch (error) {
  bad('new vm.Script(source)', String(error.message))
  console.log('\nFATAL: the bundle does not parse; stopping.')
  process.exit(1)
}
eq('no line starts an ES import/export statement', esStatement(source), null)
absent('no TypeScript type annotation (`: string`)', source, ': string')
absent('no TypeScript type annotation (`: number`)', source, ': number')
absent('no TypeScript interface declaration', source, '\n\t\tinterface ')

/* ────────────────── [2] module-loader registration ────────────────── */
section('[2] window.__ModuleLoader__.load() registration')
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const styleTags = []
const documentStub = {
  head: { appendChild: (tag) => styleTags.push(tag) },
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({
    dataset: {},
    textContent: '',
    setAttribute(name, value) {
      this[name] = value
    },
    getAttribute(name) {
      return this[name] ?? null
    }
  }),
  addEventListener: () => {},
  removeEventListener: () => {},
  body: {}
}
const confirmCalls = []
const registrations = []
const sandbox = {
  window: {
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
    addEventListener: () => {},
    removeEventListener: () => {},
    confirm: (question) => {
      confirmCalls.push(String(question))
      return sandbox.__confirmAnswer
    }
  },
  document: documentStub,
  console,
  setTimeout,
  clearTimeout,
  fetch: () => Promise.reject(new Error('the offline check never performs a real request'))
}
sandbox.__confirmAnswer = false
sandbox.globalThis = sandbox
vm.createContext(sandbox)
try {
  new vm.Script(source, { filename: BUNDLE }).runInContext(sandbox)
  ok('bundle executed against a stubbed window')
} catch (error) {
  bad('bundle execution', String(error.message))
  console.log('\nFATAL: cannot inspect the bundle; stopping.')
  process.exit(1)
}
eq('load() called exactly once', registrations.length, 1)
const registration = registrations[0] ?? {}
eq('registration.id === package.json name', registration.id, manifest.name)
eq('dsh.client.platform', manifest.dsh?.client?.platform, 'web')
eq("exports['./client'].default", manifest.exports?.['./client']?.default, './lib/client.js')
eq("exports['./client'] resolves to this file", join(ROOT, manifest.exports?.['./client']?.default ?? ''), BUNDLE)
truthy('package.json files[] ships lib/', (manifest.files ?? []).includes('lib'), JSON.stringify(manifest.files ?? []))

/* ────────────────── [3] factory + declared externals ────────────────── */
section('[3] factory surface and declared host modules')
const SEED_WORDS = new Set(['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'])
const declared = new Set(manifest.dsh?.client?.inject ?? [])
const requested = []
const reactStub = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 0 ? null : children.length === 1 ? children[0] : children }
  }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (init) => ({ current: init === undefined ? null : init }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  Fragment: Symbol('Fragment')
}
const requireStub = (specifier) => {
  requested.push(specifier)
  if (specifier === 'react') return reactStub
  if (specifier === 'react-dom') return { createPortal: (element) => element }
  throw new Error(`bundle required an undeclared module: ${specifier}`)
}
let exported
try {
  exported = registration.factory(requireStub)
  ok('factory(require) returned a module object')
} catch (error) {
  bad('factory(require)', String(error.message))
  console.log('\nFATAL: cannot inspect the bundle; stopping.')
  process.exit(1)
}
for (const specifier of [...new Set(requested)]) {
  if (SEED_WORDS.has(specifier)) ok(`requires "${specifier}" (platform seed word)`)
  else if (declared.has(specifier)) ok(`requires "${specifier}" (declared in dsh.client.inject)`)
  else bad(`requires "${specifier}"`, 'not a seed word and not declared in dsh.client.inject')
}
eq('typeof exports.apply', typeof exported.apply, 'function')
truthy('Array.isArray(exports.inject)', Array.isArray(exported.inject))
eq('exports.inject is exactly ["slots"]', exported.inject, ['slots'])
const I = exported.__internals
truthy('exports.__internals exists (the gate drives the shipped helpers)', I !== undefined)
if (I === undefined) {
  console.log('\nFATAL: nothing to drive; stopping.')
  process.exit(1)
}
eq('every __internals key the gate needs', [
  'callApi',
  'panelView',
  'usageView',
  'accountRow',
  'directoryLine',
  'checkinView',
  'formatDuration',
  'numText',
  'detailOf',
  'actRebuild',
  'actCheckin',
  'actTest',
  'emptyState',
  'WorkbuddyCardView',
  'renderedLines'
].filter((key) => I[key] === undefined), [])
eq('the singleton stylesheet was appended once', styleTags.length, 1)
has('stylesheet is labelled for the framework', String(styleTags[0]?.dataset?.plugin ?? styleTags[0]?.['data-plugin'] ?? ''), manifest.name)

/* ────────────────── [4] both settings seats ────────────────── */
section('[4] settings card seats')
const seatRegistrations = []
let currentSlot = null
const ctxStub = {
  slots: {
    inject: (name, callback) => {
      currentSlot = name
      return callback()
    },
    register: (options, component) => {
      seatRegistrations.push({ slot: currentSlot, options, component })
      return () => {}
    }
  }
}
exported.apply(ctxStub)
const keysOf = (slot) => seatRegistrations.filter((row) => row.slot === slot).map((row) => row.options.key).sort()
eq('plugins.bundle.config keys', keysOf(I.SLOT_BUNDLE), [I.PKG, I.ROW_ID].sort())
eq('plugins.row.config keys', keysOf(I.SLOT_ROW), [I.PKG + '#' + I.ROW_ID, I.ROW_ID + '#' + I.ROW_ID].sort())
eq('every seat carries its own name option', seatRegistrations.filter((row) => row.options.name !== row.slot).length, 0)
eq('every seat uses priority 30', [...new Set(seatRegistrations.map((row) => row.options.priority))], [30])
eq('every seat registered a component', seatRegistrations.filter((row) => typeof row.component !== 'function').length, 0)
// A slot the host build does not have must not cost us the other seat.
const halfRegistrations = []
const halfCtx = {
  slots: {
    inject: (name, callback) => {
      if (name === I.SLOT_ROW) throw new Error('no such slot in this build')
      currentSlot = name
      return callback()
    },
    register: (options) => {
      halfRegistrations.push(options)
      return () => {}
    }
  }
}
const warnings = []
const realWarn = console.warn
console.warn = (text) => warnings.push(String(text))
try {
  exported.apply(halfCtx)
} finally {
  console.warn = realWarn
}
eq('the surviving seat is still registered when the other slot throws', halfRegistrations.length, 2)
eq('the lost seat is reported, not swallowed', warnings.length, 2)

/* ────────────────── [5] no credentials ────────────────── */
section('[5] no credential embedded anywhere')
for (const needle of ['bearer', 'Bearer', 'authorization', 'Authorization', 'api_key', 'apiKey', 'token', 'cookie', 'localStorage', 'sessionStorage']) {
  absent(`source has no ${needle}`, source, needle)
}
absent('source has no credential file path', source, '.dsh/')
absent('source has no other plugin\'s code', source, '@deepseek-ai/')

/* ────────────────── [6] the double-prefix contract ────────────────── */
section('[6] double prefix: JSON decides, business refusals do not retry')
const calls = []
let responder = () => ({ status: 200, body: '{}' })
sandbox.fetch = async (url, init) => {
  const call = { url, method: init?.method ?? 'GET', body: init?.body }
  calls.push(call)
  const answer = responder(url, call)
  return {
    status: answer.status,
    text: async () => answer.body
  }
}
const json = (payload, status = 200) => ({ status, body: JSON.stringify(payload) })
const notJson = (status) => ({ status, body: '<html>not our handler</html>' })
const BASE_A = I.ROUTE_BASE[0]
const BASE_B = I.ROUTE_BASE[1]
eq('route bases are the two contract spellings', I.ROUTE_BASE, ['/wb2api', '/api/wb2api'])
eq('endpoint table is the frozen contract', I.EP, { panel: '/panel', action: '/action' })

// (a) the first prefix answers with JSON ⇒ exactly one request, winner remembered.
I.resetPreferredBase()
calls.length = 0
responder = () => json({ ok: true, credits: { total: 1, accounts: [] } })
let answer = await I.callApi(I.EP.panel)
eq('JSON on the first prefix ⇒ one request only', calls.map((c) => c.url), [BASE_A + '/panel'])
eq('answer.ok mirrors the server', answer.ok, true)
eq('winner remembered', I.preferredBase(), BASE_A)

// (b) the first prefix is not JSON ⇒ the second is tried, and remembered.
I.resetPreferredBase()
calls.length = 0
responder = (url) => (url.startsWith(BASE_B) ? json({ ok: true, credits: { total: 2, accounts: [] } }) : notJson(403))
answer = await I.callApi(I.EP.panel)
eq('non-JSON moves to the second prefix', calls.map((c) => c.url), [BASE_A + '/panel', BASE_B + '/panel'])
eq('the second prefix answered', answer.ok, true)
eq('the winner is remembered for the rest of the page', I.preferredBase(), BASE_B)

// (c) THE RULE: a business refusal is a normal answer — no second request, ever.
I.resetPreferredBase()
calls.length = 0
responder = () => json({ ok: false, detail: '服务端说不行' })
answer = await I.callApi(I.EP.action, { method: 'POST', body: { action: 'checkin' } })
eq('a business refusal does NOT cost a second request', calls.length, 1)
eq('a business refusal is not retried on the other prefix', calls.map((c) => c.url), [BASE_A + '/action'])
eq('answer.ok is the server\'s own false', answer.ok, false)
eq('the server detail is preserved verbatim', I.detailOf(answer.payload), '服务端说不行')
eq('the action body is exactly what the contract says', calls[0].body, JSON.stringify({ action: 'checkin' }))

// (d) both prefixes fail ⇒ the failure sentence names each path with its own status.
I.resetPreferredBase()
calls.length = 0
responder = () => notJson(403)
answer = await I.callApi(I.EP.panel)
const detail = I.detailOf(answer.payload)
eq('both prefixes were tried', calls.length, 2)
truthy('the failure names the first path + its status', detail.includes(`${BASE_A} →HTTP 403`), detail)
truthy('the failure names the second path + its status', detail.includes(`${BASE_B} →HTTP 403`), detail)
has('a 403 is described as a refusal, not as "not forwarded"', detail, '被拒绝')
has('the failure names the method and endpoint', detail, 'GET /panel')
// (e) a dead transport is reported as such, per path.
I.resetPreferredBase()
calls.length = 0
responder = () => {
  throw new Error('network down')
}
answer = await I.callApi(I.EP.panel)
has('a dead transport is reported per path', I.detailOf(answer.payload), '连接失败')
I.resetPreferredBase()

/* ────────────────── [7] all four states render ────────────────── */
section('[7] four states render, with no bare undefined/NaN')
const renderText = (element) => I.renderedLines(element).filter((row) => row !== null).join(' | ')
const clean = (label, element, expect) => {
  const shown = renderText(element)
  if (!/undefined|NaN/.test(shown)) ok(label, shown.length > 120 ? `${shown.slice(0, 117)}…` : shown)
  else bad(label, `screen text contains a ghost value: ${shown}`)
  if (expect !== undefined && !shown.includes(expect)) bad(`${label} — expected text`, JSON.stringify(expect))
}
// ready
const readyPanel = {
  ok: true,
  gateway: { reachable: true, origin: 'http://127.0.0.1:7863', healthy: 1, total: 1 },
  credits: {
    total: 3046,
    accounts: [
      { uid: 'u-1', nickname: '186****5617', realm: 'cn', credits: 3046, cooling: false, disabled: false },
      { uid: 'u-2', nickname: '139****0001', realm: 'cn', credits: 12, cooling: true, disabled: false }
    ]
  },
  models: { gatewayTotal: 48, unknownPrice: 12, providerModelCount: 46 },
  provider: { exists: true, ns: 'llm-pi-ai', lastOffered: 48 },
  usage: { enabled: true, since: '2026-10-14T10:00:00+08:00', requests: 0, credit: 0, uptimeSec: 2793, models: [] },
  checkin: { supported: true, note: '签到直连上游，会改变账号状态' }
}
const readyView = I.panelView(readyPanel)
const cardElement = I.WorkbuddyCardView({
  panel: readyView,
  gateway: readyView.gateway,
  credits: readyView.credits,
  directory: readyView.directory,
  usage: readyView.usage,
  checkin: readyView.checkin,
  rebuild: { phase: 'ready', detail: '新增 2 个 · 保留 46 个', added: ['a', 'b'], serverDetail: 'guard 通过' },
  claim: { phase: 'ready', detail: '今日已领取' },
  test: { phase: 'ready', detail: '', lines: ['m-1 · ok'] },
  busy: ''
})
clean('[ready] the whole card renders', cardElement)
const readyText = renderText(cardElement)
has('[ready] the masked nickname is on screen', readyText, '186****5617')
has('[ready] the realm is on screen', readyText, 'realm cn')
has('[ready] the per-account credits are on screen', readyText, '额度 3046')
has('[ready] a cooling account says so', readyText, '冷却中')
has('[ready] usage.since is on screen', readyText, '2026-10-14T10:00:00+08:00')
has('[ready] requests 0 is next to its window', readyText, '窗口内请求 0 次')
has('[ready] provider.lastOffered is compared with providerModelCount', readyText, '配额记录（墓碑）48 个')
has('[ready] the tombstone comparison is stated', readyText, '墓碑比实际多 2 个')
has('[ready] checkin.note sits next to the button', readyText, '签到直连上游，会改变账号状态')
has('[ready] the test button says it costs credits', readyText, '测试模型（会花额度）')
has('[ready] the rebuild result is on screen', readyText, '新增 2 个 · 保留 46 个')
// The destructive button's OWN LABEL must state the cost (a user should not have to
// press it to find out), and the first-run dead end must be explained on screen.
has('[ready] the destructive button states its cost in its label', readyText, '会覆盖你在模型页做的筛选')
has('[ready] the first-run dead end is explained next to the additive button', readyText, '故意一个都不加')
// loading / error / empty
clean('[loading] the initial view-model renders', I.WorkbuddyCardView(I.emptyState()), '读取中…')
clean('[error] the server detail is shown verbatim', I.WorkbuddyCardView({ panel: { phase: 'error', detail: '路由没有注册' } }), '路由没有注册')
clean('[error] no detail ⇒ the stated fallback, never a blank', I.WorkbuddyCardView({ panel: { phase: 'error', detail: '' } }), '失败（服务端没有给出原因）')
clean('[empty] an empty panel renders', I.WorkbuddyCardView({ panel: { phase: 'empty', detail: '' } }), '（空）')
// a panel that is missing every optional key must still render cleanly.
clean('[ready] a bare payload renders', I.WorkbuddyCardView({ panel: I.panelView({ ok: true }) }))
eq('a bare payload invents no zero', I.numText(undefined), '?')

/* ────────────────── [8] the two dangerous buttons ────────────────── */
section('[8] mount, 签到, 重建清单, 完全重建, 测试模型')
calls.length = 0
responder = () => json({ ok: true })
// The component itself must not request anything when it is merely RENDERED.
const rendered = I.WorkbuddyCard()
truthy('rendering the component is not a request', calls.length === 0, `calls: ${calls.length}`)
truthy('rendering the component produced a card element', rendered !== undefined && rendered !== null)
// 签到: one click ⇒ exactly one POST, no confirmation dialog.
calls.length = 0
confirmCalls.length = 0
responder = () => json({ ok: true, detail: '今日已领取' })
const claimResult = await I.actCheckin()
eq('签到 sends exactly one request', calls.length, 1)
eq('签到 is a POST to /action', { url: calls[0].url, method: calls[0].method }, { url: BASE_A + '/action', method: 'POST' })
eq('签到 body is {action:"checkin"}', calls[0].body, JSON.stringify({ action: 'checkin' }))
eq('签到 asks no confirmation', confirmCalls.length, 0)
eq('签到 says what the server said', claimResult.detail, '今日已领取')
// 重建清单 declined ⇒ nothing is sent; accepted ⇒ one POST that explains 只增不删.
calls.length = 0
confirmCalls.length = 0
const declined = await I.actRebuild(() => false)
eq('declined 重建清单 sends nothing', calls.length, 0)
eq('declined 重建清单 stays idle', declined.phase, 'idle')
calls.length = 0
confirmCalls.length = 0
responder = () => json({ ok: true, added: ['m-new'], keptCount: 46 })
const rebuilt = await I.actRebuild((question) => {
  confirmCalls.push(question)
  return true
})
eq('重建清单 asks once', confirmCalls.length, 1)
has('重建清单 explains 只增不删 in the dialog', confirmCalls[0], '只增不删')
has('重建清单 explains that deleted models do not come back', confirmCalls[0], '不会复活')
eq('重建清单 sends exactly one POST', calls.length, 1)
eq('重建清单 body', calls[0].body, JSON.stringify({ action: 'rebuild' }))
eq('重建清单 reports the add-new-only result', rebuilt.detail, '新增 1 个 · 保留 46 个')
eq('重建清单 lists the added ids', rebuilt.added, ['m-new'])
// A server-side "I added nothing on purpose" (no tombstone record) must reach the
// screen — otherwise the button just looks broken on first use.
calls.length = 0
responder = () => json({ ok: true, added: [], keptCount: 6, modelCount: 6, holdReason: '没有墓碑记录', hint: '首次使用时它故意一个都不加，请用「完全重建」' })
const held = await I.actRebuild(() => true)
eq('重建清单 keeps the server hint', held.hint, '首次使用时它故意一个都不加，请用「完全重建」')
has('[ready] the hint is rendered', renderText(I.WorkbuddyCardView({ panel: readyView, rebuild: held })), '故意一个都不加')
// 完全重建: this is the DESTRUCTIVE one — declined ⇒ nothing is sent; accepted ⇒
// exactly one POST that carries `reset:true` (the flag the host keys the overwrite on).
calls.length = 0
confirmCalls.length = 0
const resetDeclined = await I.actReset(() => false)
eq('declined 完全重建 sends nothing', calls.length, 0)
eq('declined 完全重建 stays idle', resetDeclined.phase, 'idle')
calls.length = 0
confirmCalls.length = 0
responder = () => json({ ok: true, writtenCount: 48, addedCount: 42, droppedCount: 2, written: ['m-a', 'm-b'], dropped: ['m-gone-1', 'm-gone-2'] })
const resetDone = await I.actReset((question) => {
  confirmCalls.push(question)
  return true
})
eq('完全重建 asks once', confirmCalls.length, 1)
has('完全重建 names the cost in the dialog', confirmCalls[0], '会覆盖你在模型页做的筛选')
has('完全重建 says deleted models come back', confirmCalls[0], '你删掉的会回来')
eq('完全重建 sends exactly one POST', calls.length, 1)
eq('完全重建 body carries reset:true', calls[0].body, JSON.stringify({ action: 'rebuild', reset: true }))
eq('完全重建 reports write/add/drop counts', resetDone.detail, '写入 48 个 · 新增 42 个 · 丢掉 2 个')
eq('完全重建 lists the dropped ids', resetDone.dropped, ['m-gone-1', 'm-gone-2'])
has('[ready] the dropped ids are rendered', renderText(I.WorkbuddyCardView({ panel: readyView, reset: resetDone })), '丢掉：m-gone-1、m-gone-2')
// 测试模型: no confirmation ⇒ NO request; confirmed ⇒ confirm:true in the body.
calls.length = 0
const refused = await I.actTest({})
eq('测试模型 without confirmation sends nothing', calls.length, 0)
eq('测试模型 without confirmation says why', refused.needsConfirm, true)
calls.length = 0
responder = () => json({ ok: true, results: [{ id: 'm-1', verdict: 'ok' }, { id: 'm-2', verdict: 'failed: 401' }] })
const tested = await I.actTest({ confirmed: true })
eq('测试模型 confirmed ⇒ exactly one request', calls.length, 1)
eq('测试模型 carries confirm:true in the body', calls[0].body, JSON.stringify({ action: 'test', confirm: true }))
eq('测试模型 shows one line per model', tested.lines, ['m-1 · ok', 'm-2 · failed: 401'])
for (const call of calls) {
  truthy('every action URL is one of the two prefixes', call.url.startsWith(BASE_A + '/') || call.url.startsWith(BASE_B + '/'), call.url)
}

/* ────────────────── [9] degenerate input ────────────────── */
section('[9] degenerate input does not throw or invent')
const junk = [undefined, null, 0, '', [], 'text', { detail: 42 }, { usage: [] }, { credits: null }, { models: 'x' }]
let threw = null
for (const value of junk) {
  try {
    I.panelView(value)
    I.usageView(value)
    I.accountRow(value)
    I.directoryLine(value)
    I.checkinView(value)
    I.shapedCredits(value)
    I.numText(value)
    I.formatDuration(value)
    I.detailOf(value)
    // Each block is fed the junk through its OWN accessor, then rendered.
    I.renderedLines(
      I.WorkbuddyCardView({
        panel: { phase: 'ready', detail: '' },
        credits: I.shapedCredits(value),
        usage: I.usageView({ usage: value }),
        checkin: I.checkinView({ checkin: value }),
        directory: I.directoryLine({ models: value, provider: value })
      })
    )
  } catch (error) {
    threw = `${JSON.stringify(value)} ⇒ ${error.message}`
    break
  }
}
eq('no formatter and no render throws on junk', threw, null)
// The mount state and a caller that passed nothing at all must render too.
threw = null
for (const vm of [I.emptyState(), {}, undefined, { panel: { phase: 'ready', detail: '' } }]) {
  try {
    I.renderedLines(I.WorkbuddyCardView(vm))
  } catch (error) {
    threw = `${JSON.stringify(vm)} ⇒ ${error.message}`
    break
  }
}
eq('the seed view-model and a bare call render', threw, null)
eq('numText(0) is a real zero, not a ghost', I.numText(0), '0')
eq('formatDuration(2793)', I.formatDuration(2793), '46 分')
eq('formatDuration(-1) refuses to guess', I.formatDuration(-1), '未知')
eq('a missing detail is an empty string', I.detailOf({}), '')
eq('a non-string detail is not printed', I.detailOf({ detail: 42 }), '')
const emptyUsage = I.usageView({ usage: {} })
eq('an absent usage block is an empty state, not zeros', emptyUsage.phase, 'empty')
truthy('an absent usage block says so', emptyUsage.note.includes('没有返回用量'), emptyUsage.note)

/* ────────────────── [10] every stated figure has a home ────────────────── */
section('[10] the contract shape reaches the screen')
eq('panelView(readyPanel).phase', readyView.phase, 'ready')
eq('accounts are listed one per row', readyView.credits.accounts.map((row) => row.nickname), ['186****5617', '139****0001'])
eq('the cooling flag becomes a status word', readyView.credits.accounts[1].state, '冷却中')
eq('disabled is not confused with cooling', readyView.credits.accounts[0].state, '')
has('the directory line carries the gateway total', readyView.directory.line, '网关目录 48 个')
has('the directory line carries the live provider count', readyView.directory.line, '供应商清单 46 个')
has('the directory line carries the tombstone count', readyView.directory.line, '配额记录（墓碑）48 个')
has('the directory comparison is present', readyView.directory.compare, '墓碑比实际多 2 个')
truthy('usage.since is carried through', readyView.usage.rows[0].includes('2026-10-14T10:00:00+08:00'), readyView.usage.rows[0])
truthy('the uptime is a duration, not a clock', readyView.usage.rows[2].includes('46 分'), readyView.usage.rows[2])
eq('checkin support is carried through', readyView.checkin.supported, true)
eq('the ready view-model has no detail left over', readyView.detail, '')

/* ────────────────── summary ────────────────── */
console.log(`\n${'-'.repeat(78)}`)
console.log(`${checks} 项检查：${checks - failures} PASS · ${failures} FAIL`)
if (failures > 0) {
  console.log('结论：卡片 bundle 不合法，页面加载它会在下面这些点上出错。')
  process.exit(1)
}
console.log('结论：离线口径全部通过（未在真浏览器里渲染过；见 tools/_run-suites.mjs 的说明）。')
