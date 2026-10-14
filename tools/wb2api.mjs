#!/usr/bin/env node
/**
 * workbuddy2api CLI — 不依赖 DSH UI / 不依赖 DSH 进程，直连本地网关。
 *
 *   node tools/wb2api.mjs status                  账号健康 / 积分 / 冷却      ← GET /status
 *   node tools/wb2api.mjs models [--limit N]      网关模型目录               ← GET /v1/models
 *   node tools/wb2api.mjs usage [--limit N]       按模型用量台账             ← GET /v1/stats
 *   node tools/wb2api.mjs test --model <id> --yes ⚠️ 花额度：发一条极小消息   ← POST /v1/chat/completions
 *   node tools/wb2api.mjs checkin                 ⚠️ 本 build 无此端点，如实报不可用
 *
 * 与 dsh-trae 的 tools/trae.ts 的关键差异：
 *   Trae 的 CLI 打**自己插件进程的** /admin/*（要求插件正在跑）；
 *   本 CLI **不自建端点**，直接打网关 http://127.0.0.1:7863（只要网关在跑）。
 *
 * 凭据纪律：api_key 只从 config.json 读进内存当 Bearer 头，
 *           **从不打印**（要提只提 sha256 前 12 位）。
 * 只读纪律：status / models / usage / checkin 全部只读；
 *           唯一会改账号状态且花额度的是 test，且必须有 --yes。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_PORT = '7863'
const VERSION = '0.1.0'

// ── 参数解析（骨架照抄 插件/dsh-trae/tools/trae.ts:25-33）────────────────────
const argv = process.argv.slice(2)
const command = argv.find((value) => !value.startsWith('-')) ?? 'status'
const flag = (name) => argv.includes(`--${name}`)
const option = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}
const line = (char = '-', width = 78) => char.repeat(width)
const print = (label, value) =>
  console.log(`${label.padEnd(16)} ${typeof value === 'string' ? value : JSON.stringify(value)}`)

/** 中英混排对齐：CJK 全角按 2 列算。 */
const wide = (value) =>
  [...String(value)].reduce((sum, ch) => sum + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0)
const pad = (value, width) => {
  const text = String(value ?? '')
  return text + ' '.repeat(Math.max(0, width - wide(text)))
}
const num = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

// ── 退出码：0 成功 · 2 用法错 · 1 网关不可达或接口报错 ───────────────────────
class UsageError extends Error {}
const usage = (message) => {
  throw new UsageError(message)
}

// ── 配置：config.json 的 listen / api_key ──────────────────────────────────
const dshHome = () => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')

function configPath() {
  return option('config') ?? join(dshHome(), 'wb2api', 'config.json')
}

function loadConfig() {
  const path = configPath()
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(
      `读不到网关配置（${path}）：${error instanceof Error ? error.message : String(error)}\n` +
        `  提示：确认 DSH_HOME（当前 ${dshHome()}）下已安装 wb2api，或用 --config <path> 指定。`
    )
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`配置不是合法 JSON（${path}）：${error instanceof Error ? error.message : String(error)}`)
  }
  const listen = typeof parsed?.listen === 'string' && parsed.listen.trim() !== '' ? parsed.listen.trim() : `127.0.0.1:${DEFAULT_PORT}`
  const apiKey = typeof parsed?.api_key === 'string' ? parsed.api_key.trim() : ''
  return { path, listen, apiKey }
}

/** 只允许 12 位指纹出现在任何输出里。 */
const fingerprint = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12)

function originOf(listen) {
  const override = option('origin') ?? option('gateway')
  if (override !== undefined) return override.replace(/\/+$/, '')
  const host = listen.includes('://') ? listen : `http://${listen}`
  // listen 常见形态 127.0.0.1:7863 / :7863 / 0.0.0.0:7863；0.0.0.0 不能当目标拨号。
  return host.replace(/\/+$/, '').replace('://0.0.0.0', '://127.0.0.1').replace('://[::]', '://127.0.0.1')
}

// ── HTTP ──────────────────────────────────────────────────────────────────
async function request(origin, apiKey, path, { method = 'GET', body, timeoutMs = 20000, tolerate404 = false } = {}) {
  const url = `${origin}${path}`
  const headers = { Accept: 'application/json' }
  if (apiKey !== '') headers.Authorization = `Bearer ${apiKey}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `网关不可达 ${method} ${url}：${detail}\n` +
        `  排查：网关进程是否在跑？（wb2a-server / wb2api 插件）· 端口对不对？（config.json listen=${origin}）· 用 --origin <url> 覆盖。`
    )
  }
  const text = await response.text()
  // tolerate404：404 的响应体由网关自己决定（本 build 是纯文本 `404 page not found`），
  // 不当 JSON 解析失败处理 —— 404 本身就是结论。
  if (tolerate404 && response.status === 404) {
    return { status: response.status, body: undefined, text: text.trim() }
  }
  let parsed
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`网关回答的不是 JSON（HTTP ${response.status} ${method} ${path}）：${text.slice(0, 200)}`)
    }
  }
  if (!response.ok) {
    const hint =
      response.status === 401
        ? '\n  401 = api_key 不对或为空。检查 config.json 的 api_key。'
        : ''
    throw new Error(
      `网关返回 HTTP ${response.status} ${method} ${path}${text.trim() === '' ? '（空体）' : `：${text.slice(0, 300)}`}${hint}`
    )
  }
  return { status: response.status, body: parsed, text: text.trim() }
}

const getJson = async (ctx, path, options) => {
  const { body } = await request(ctx.origin, ctx.apiKey, path, options)
  if (body === undefined || body === null || typeof body !== 'object') {
    throw new Error(`网关 ${path} 返回了非对象体：${JSON.stringify(body)?.slice(0, 200)}`)
  }
  return body
}

const clip = (value, width) => {
  const text = String(value ?? '')
  return wide(text) <= width ? text : `${[...text].slice(0, Math.max(1, width - 1)).join('')}…`
}

// ── /status ───────────────────────────────────────────────────────────────
/** nickname 在本 build 是手机号 —— 一律脱敏，绝不打印原文。 */
function maskNickname(value) {
  const text = String(value ?? '')
  if (text === '') return '(空)'
  if (/^\d{7,}$/.test(text)) return `${text.slice(0, 3)}****${text.slice(-4)}`
  if (text.length <= 4) return `${text[0]}***`
  return `${text.slice(0, 2)}***${text.slice(-2)}`
}

async function cmdStatus(ctx) {
  const body = await getJson(ctx, '/status')
  const accounts = Array.isArray(body.accounts) ? body.accounts : []
  const credits = accounts.reduce((sum, entry) => sum + num(entry?.credits), 0)
  console.log(line('='))
  console.log(`账号台账 · total=${body.total ?? '?'} healthy=${body.healthy ?? '?'} cooling=${body.cooling ?? '?'} disabled=${body.disabled ?? '?'} in_flight_full=${body.in_flight_full ?? '?'}`)
  console.log(line('='))
  print('credits 合计', credits)
  print('redis_mode', body.redis_mode)
  print('sticky_sessions', body.sticky_sessions)
  const realms = body.realm_totals
  if (realms !== undefined && realms !== null) print('realm_totals', realms)
  const explore = body.cost_explore
  if (explore !== undefined && explore !== null) print('cost_explore', { events_total: explore.events_total ?? 0, models: Object.keys(explore.per_model ?? {}).length })
  console.log(line('-'))
  if (accounts.length === 0) console.log('  (账号池为空)')
  for (const entry of accounts) {
    console.log(
      `  ${pad(entry?.realm ?? '?', 7)}${pad(entry?.uid ?? '?', 40)}${pad(maskNickname(entry?.nickname), 16)}` +
        `${pad(`credits=${entry?.credits ?? '?'}`, 14)}${`cooling=${entry?.cooling === true ? 'Y' : 'n'}`.padEnd(12)}` +
        `${`disabled=${entry?.disabled === true ? 'Y' : 'n'}`.padEnd(14)}${`ok=${entry?.success_count ?? '?'}`.padEnd(9)}` +
        `${`fails=${entry?.consecutive_fails ?? '?'}`}`
    )
  }
  console.log(line('-'))
  const missing = []
  for (const key of ['cool_kind', 'cool_remaining_sec', 'model_costs', 'daily_budget', 'task_ledger', 'rate_limited_models']) {
    if (body[key] === undefined) missing.push(key)
  }
  if (missing.length > 0) {
    console.log(`  ⚠️ 本 build 的 /status 不含这些段（上游新版本才有）：${missing.join(' · ')}`)
  }
  if (accounts.some((entry) => entry?.cooling === true)) {
    console.log('  ⚠️ 有账号在冷却，但本 build 不吐 cool_kind / cool_remaining_sec ⇒ 看不到冷却原因与剩余时间。')
  }
  return 0
}

// ── /v1/models ────────────────────────────────────────────────────────────
const creditsOf = (model) => (typeof model?.credits === 'string' && model.credits.trim() !== '' ? model.credits.trim() : undefined)

function inputModalities(model) {
  const explicit = model?.input_modalities ?? model?.modalities?.input
  if (Array.isArray(explicit) && explicit.length > 0) return explicit.map(String)
  const flags = []
  if (model?.supports_images === true || model?.supports_vision === true || model?.supports_image === true) flags.push('image')
  if (model?.supports_audio === true) flags.push('audio')
  if (model?.supports_video === true) flags.push('video')
  return flags.length > 0 ? flags : ['text']
}

async function cmdModels(ctx) {
  const limit = limitOf(20)
  const body = await getJson(ctx, '/v1/models')
  const list = Array.isArray(body.data) ? body.data : []
  if (list.length === 0) throw new Error('/v1/models 返回空目录')
  if (flag('json')) {
    console.log(JSON.stringify(limit === 0 ? list : list.slice(0, limit), null, 2))
    return 0
  }
  const unknown = list.filter((model) => creditsOf(model) === undefined).length
  console.log(line('='))
  console.log(`模型目录 · 共 ${list.length} 个 · 单价未知（无 credits 字段）${unknown} 个` + (limit === 0 ? ' · 全量' : ` · 显示前 ${Math.min(limit, list.length)} 个`))
  console.log(line('='))
  console.log(`  ${pad('id', 30)}${pad('name', 26)}${pad('ctx', 9)}${pad('max_out', 9)}${pad('输入', 14)}${pad('单价', 8)}备注`)
  console.log(`  ${line('-', 108)}`)
  for (const model of limit === 0 ? list : list.slice(0, limit)) {
    const credits = creditsOf(model)
    const tags = Array.isArray(model?.tags) ? model.tags.map(String) : []
    const notes = [
      model?.vendor === undefined ? undefined : `vendor=${model.vendor}`,
      model?.is_default === true ? 'default' : undefined,
      model?.supports_reasoning === true ? 'reasoning' : undefined,
      tags.length > 0 ? tags.join(',') : undefined
    ].filter(Boolean).join(' ')
    console.log(
      `  ${pad(clip(model?.id, 29), 30)}${pad(clip(model?.name ?? '', 25), 26)}` +
        `${pad(model?.context_length ?? '?', 9)}${pad(model?.max_output_tokens ?? '?', 9)}` +
        `${pad(inputModalities(model).join('+'), 14)}` +
        `${pad(credits ?? '未知', 8)}${notes}`
    )
  }
  console.log(line('-'))
  if (unknown > 0) console.log(`  ⚠️ ${unknown} 个模型没有 credits 字段 ⇒ 单价未知（test 默认拒测，要测加 --force）。`)
  return 0
}

function limitOf(fallback) {
  const raw = option('limit')
  if (raw === undefined) return flag('all') ? 0 : fallback
  if (raw === 'all') return 0
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) usage(`--limit 需要非负整数（收到 ${JSON.stringify(raw)}），0 = 全量`)
  return value
}

// ── /v1/stats ─────────────────────────────────────────────────────────────
const fmtNum = (value, digits = 0) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : String(value ?? '?'))
const fmtCredit = (value) => (typeof value === 'number' && Number.isFinite(value) ? (Math.round(value * 1e6) / 1e6).toString() : String(value ?? '?'))

function statRow(stat) {
  const cacheTotal = num(stat.cache_hit_tokens) + num(stat.cache_miss_tokens)
  const hitRate = num(stat.cache_hit_rate) > 0 ? `${(num(stat.cache_hit_rate) * 100).toFixed(1)}%` : cacheTotal > 0 ? `${((num(stat.cache_hit_tokens) / cacheTotal) * 100).toFixed(1)}%` : '-'
  return {
    model: String(stat.model ?? stat.id ?? '?'),
    requests: num(stat.requests),
    success: num(stat.success),
    failed: num(stat.failed),
    streaming: num(stat.streaming),
    credit: num(stat.credit),
    perReq: num(stat.credit_per_req),
    promptTokens: num(stat.prompt_tokens),
    completionTokens: num(stat.completion_tokens),
    totalTokens: num(stat.total_tokens),
    cacheRatio: hitRate,
    ttfb: num(stat.avg_ttfb_ms),
    latency: num(stat.avg_latency_ms),
    tps: num(stat.tokens_per_sec)
  }
}

function printStatsTable(rows) {
  console.log(`  ${pad('model', 30)}${pad('req', 6)}${pad('成功/失败', 12)}${pad('credit', 11)}${pad('c/req', 10)}${pad('token', 16)}${pad('缓存命中', 10)}${pad('ttfb', 8)}${pad('延时', 8)}tok/s`)
  console.log(`  ${line('-', 118)}`)
  for (const row of rows) {
    console.log(
      `  ${pad(clip(row.model, 29), 30)}${pad(row.requests, 6)}${pad(`${row.success}/${row.failed}`, 12)}` +
        `${pad(fmtCredit(row.credit), 11)}${pad(fmtCredit(row.perReq), 10)}` +
        `${pad(`${row.promptTokens}+${row.completionTokens}=${row.totalTokens}`, 16)}` +
        `${pad(row.cacheRatio, 10)}${pad(fmtNum(row.ttfb), 8)}${pad(fmtNum(row.latency), 8)}${fmtNum(row.tps, 1)}`
    )
  }
}

async function cmdUsage(ctx) {
  if (option('limit') !== undefined || flag('all')) usage('usage 不接受 --limit / --all（/v1/stats 没有分页参数，台账本就只列有记录的模型）')
  const body = await getJson(ctx, '/v1/stats')
  if (flag('json')) {
    console.log(JSON.stringify(body, null, 2))
    return 0
  }
  const models = Array.isArray(body.models) ? body.models.map(statRow) : []
  const rows = models.filter((row) => row.requests > 0 || row.totalTokens > 0 || row.credit > 0).sort((a, b) => b.credit - a.credit || b.requests - a.requests)
  console.log(line('='))
  console.log(`用量台账 · enabled=${body.enabled ?? '?'} · uptime=${body.uptime_sec ?? '?'}s · 有记录的模型 ${rows.length}/${models.length}`)
  console.log(`since           ${body.since ?? '?'}`)
  console.log(`now             ${body.now ?? '?'}`)
  console.log(line('='))
  if (body.total !== undefined && body.total !== null) {
    const total = statRow(body.total)
    print('requests', `${total.requests}（成功 ${total.success} / 失败 ${total.failed} / 流式 ${total.streaming}）`)
    print('credit', `${fmtCredit(total.credit)}（均值 ${fmtCredit(total.perReq)}/请求）`)
    print('tokens', `${total.promptTokens} prompt + ${total.completionTokens} completion = ${total.totalTokens}`)
    print('cache', `hit=${num(body.total.cache_hit_tokens)} miss=${num(body.total.cache_miss_tokens)} write=${num(body.total.cache_write_tokens)} 命中率=${total.cacheRatio}`)
    print('延迟', `ttfb=${fmtNum(total.ttfb)}ms 延时=${fmtNum(total.latency)}ms ${fmtNum(total.tps, 1)}tok/s`)
  }
  console.log(line('-'))
  if (models.length === 0) {
    console.log('  (models[] 为空 —— 自 since 以来一次请求都没有)')
  } else {
    printStatsTable(limit === 0 ? rows : rows.slice(0, limit))
  }
  console.log(line('-'))
  console.log('  ⚠️ 口径三条，别误读：')
  console.log('     ① credit 只统计上游 usage 给了 credit 的请求 ⇒ 是**下界**，真实消耗只会更多。')
  console.log(`     ② since=${body.since ?? '?'} 是**进程启动或上次 /v1/stats/reset** 的时刻 ⇒ 网关一重启就归零。`)
  console.log('     ③ 没有按日聚合、没有 uid 维度 —— 只有「自 since 以来的累计 / 按模型」。')
  return 0
}

// ── test（唯一花额度的命令）──────────────────────────────────────────────
const DEFAULT_TEST_PROMPT = 'ping'

async function cmdTest(ctx) {
  const model = option('model')
  if (model === undefined || model.trim() === '') {
    console.error('test 需要 --model <id>（它会发一条极小的真实消息，消耗额度）')
    console.error('  先看有哪些模型：  node tools/wb2api.mjs models --limit 0')
    return 2
  }
  const modelId = model.trim()

  // 成本闸 1：单价未知的模型默认拒测。
  const directory = await getJson(ctx, '/v1/models')
  const entry = (Array.isArray(directory.data) ? directory.data : []).find((item) => item?.id === modelId)
  if (entry === undefined) {
    console.error(`目录里没有模型 ${JSON.stringify(modelId)} —— 先 node tools/wb2api.mjs models --limit 0 看 id。`)
    return 2
  }
  const credits = creditsOf(entry)
  if (credits === undefined && !flag('force')) {
    console.error(`⛔ 拒绝测试 ${modelId}：目录里没有 credits 字段 ⇒ 单价未知，等于开盲盒。`)
    console.error('   要接受未知花费请显式加 --force。')
    return 2
  }
  if (credits !== undefined && !/^x0(\.0+)?$/.test(credits) && !flag('force')) {
    console.error(`⚠️  ${modelId} 的单价是 ${credits}（非免费）。`)
    console.error('   要真花钱请显式加 --force（免费模型 x0.00 不需要）。')
    return 2
  }

  // 成本闸 2：必须显式确认。
  if (!flag('yes')) {
    console.error('⛔ test 会向网关发一条**真实**消息并消耗额度，必须显式确认。')
    console.error(`   确认后重跑：  node tools/wb2api.mjs test --model ${modelId} --yes${credits === undefined ? ' --force' : ''}`)
    console.error(`   该模型单价（目录 credits 字段，仅展示倍率、不等于实际计费）：${credits ?? '未知'}`)
    return 2
  }

  const maxTokens = Number(option('max-tokens') ?? 16)
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 512) usage('--max-tokens 需要 1..512 的整数')
  const prompt = option('prompt') ?? DEFAULT_TEST_PROMPT

  console.log('⚠️  这会向网关发一条真实消息（最小 ping），消耗额度 —— 下面报的是**实测**花费，不是估算。')
  console.log(line('='))
  print('model', modelId)
  print('credits', credits ?? '未知（--force 覆盖）')
  print('max_tokens', maxTokens)
  print('prompt', `${JSON.stringify(prompt)}（${prompt.length} 字符）`)

  const before = await getJson(ctx, '/v1/stats')
  print('before.since', before.since)
  print('before.credit', fmtCredit(num(before.total?.credit)))
  print('before.requests', num(before.total?.requests))
  console.log(line('-'))

  const startedAt = Date.now()
  const { status, body } = await request(ctx.origin, ctx.apiKey, '/v1/chat/completions', {
    method: 'POST',
    timeoutMs: 120000,
    body: { model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, stream: false }
  })
  const elapsed = Date.now() - startedAt

  const after = await getJson(ctx, '/v1/stats')
  const beforeCredit = num(before.total?.credit)
  const afterCredit = num(after.total?.credit)
  const delta = afterCredit - beforeCredit
  const sinceChanged = before.since !== after.since

  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined
  const content = choice?.message?.content
  const usage = body.usage ?? {}
  print('HTTP', status)
  print('耗时', `${elapsed}ms`)
  print('finish_reason', choice?.finish_reason)
  print('content', typeof content === 'string' ? JSON.stringify(clip(content, 120)) : String(content))
  print('usage', usage)
  print('上游 credit', body.credit ?? body.usage?.credit ?? '(响应里没有)')
  const perModel = (Array.isArray(after.models) ? after.models : []).find((item) => String(item?.model ?? item?.id) === modelId)
  if (perModel !== undefined) print('该模型台账', { requests: perModel.requests, credit: perModel.credit, total_tokens: perModel.total_tokens })
  console.log(line('-'))
  if (sinceChanged) {
    console.log('⚠️  since 变了（网关在测试期间重启或 /v1/stats/reset 过）⇒ 本次 credit 差值无效，下面这条不可信。')
    print('实测花费', 'n/a（基线失效）')
  } else {
    print('实测花费 credit', `${fmtCredit(beforeCredit)} → ${fmtCredit(afterCredit)} = ${delta >= 0 ? '+' : ''}${fmtCredit(delta)}`)
    if (delta === 0) {
      console.log('  ⇒ 实测本次 credit 增量为 0（可能真的免费，也可能上游这次没回 credit ⇒ 只能算下界）。')
    }
  }
  print('token 实测', `${num(usage.prompt_tokens)} + ${num(usage.completion_tokens)} = ${num(usage.total_tokens)}`)
  if (num(usage.completion_tokens) === 0 && (content === '' || content === null || content === undefined)) {
    console.log('  ⚠️ completion_tokens=0 且内容为空 —— reasoning 模型思考与回答共用输出预算，太小会返回空内容而不是报错。')
  }
  return 0
}

// ── checkin（本 build 不可用 —— 如实报，绝不假装成功）────────────────────
async function cmdCheckin(ctx) {
  console.log(line('='))
  console.log('checkin · 本 build（UPSTREAM_REF 1c9aef9ab378，2026-09-20）**没有**手动签到端点')
  console.log(line('='))
  print('结论', '不可用')
  print('原因', '网关二进制里没有任何 checkin handler，也没有手动签到路由')
  print('依赖', 'POST /v1/checkin 与 GET /v1/checkin/history 都在 pin 之后的上游')
  print('前置动作', '升级 UPSTREAM_REF 并重发二进制，再重跑本命令')
  console.log(line('-'))
  console.log('  实测探针（只发 GET，不写任何状态）：')
  const probes = [
    ['GET', '/v1/checkin'],
    ['GET', '/v1/checkin/history']
  ]
  let unreachable = false
  for (const [method, path] of probes) {
    try {
      const { status, text } = await request(ctx.origin, ctx.apiKey, path, { method, tolerate404: true })
      // 404 = 路由不存在；405 = 路由存在但不收 GET（即真有 POST /v1/checkin）。
      const verdict =
        status === 404
          ? `404 路由不存在（体：${JSON.stringify(clip(text, 40))}）`
          : status === 405
            ? '405 路由存在但不收 GET ⇒ 有手动签到端点！'
            : `HTTP ${status}（意外，请人工确认）`
      console.log(`    ${method} ${path.padEnd(22)} -> ${verdict}`)
    } catch (error) {
      unreachable = true
      console.log(`    ${method} ${path.padEnd(22)} -> 探测失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }
  console.log('  注：探针走的是**带 Bearer** 的请求 ⇒ 404 就是真 404，不是未鉴权被挡。')
  console.log(line('-'))
  console.log('  能替代的路（都要用户自己决定）：')
  console.log('    · 网关自带自动调度器（本机 config 无 schedule 段 ⇒ 默认 [9,21] 每天自动签两次）——')
  console.log('      它是**越界项**，官方《限时每日活跃奖励说明》明文禁止「脚本/接口调用」刷活跃；')
  console.log('      要关：config.json 里 schedule.checkin_enabled = false（**本 CLI 绝不代改**）。')
  console.log('    · 升级 UPSTREAM_REF 后用 GET /v1/checkin/history 只读查状态 + POST /v1/checkin 显式领取。')
  return unreachable ? 1 : 0
}

// ── --help ────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`wb2api CLI v${VERSION} — 直连本地网关，不需要 DSH UI、不需要 DSH 进程
用法：node tools/wb2api.mjs <命令> [选项]

命令
  status                     账号健康 / 积分 / 冷却（GET /status，只读，零积分）
  models [--limit N]         网关模型目录：id / 名字 / 上下文 / 输入模态 / 单价
                             （GET /v1/models，只读。--limit 0 或 --all = 全量，默认 20）
  usage                      ★ 按模型用量台账（GET /v1/stats，只读，零积分）
                             字段：requests / credit / credit_per_req / token / 缓存 / 延迟
                             （无分页参数：台账只列「有记录」的模型，按 credit 降序）
  test --model <id> --yes    ⚠️ 花额度：发一条极小消息（POST /v1/chat/completions）
  checkin                    ⚠️ 本 build 没有此端点 —— 如实报不可用，不会假装成功

通用选项
  --origin <url>             覆盖网关地址（默认读 config.json 的 listen，即 http://127.0.0.1:7863）
  --config <path>            覆盖 config.json 路径
  --json                     输出原始 JSON（models / usage）
  --help, -h                 显示本帮助

test 的选项（唯一会花钱的命令）
  --model <id>               必需。要测的模型 id（models 命令里那一列）
  --yes                      必需。显式确认「我知道这会花钱」
  --force                    覆盖两道成本闸：① 单价未知（无 credits 字段）② 单价非免费
  --max-tokens <n>           默认 16，允许 1..512
  --prompt <text>            默认 "ping"
  实测成本：测试前后各读一次 /v1/stats，用 credit 差值报出**实测**花费，不估算。

退出码
  0  成功
  2  用法错（缺少必需参数、参数非法、命中成本闸）
  1  网关不可达，或接口返回错误（含 401 / 5xx / 非 JSON）

凭据纪律
  api_key 只从 config.json 读进内存当 Bearer 头，从不打印；要提只提 sha256 前 12 位。
  本 build 的 /status.nickname 是手机号，输出一律脱敏。

示例
  node tools/wb2api.mjs status
  node tools/wb2api.mjs models --limit 30
  node tools/wb2api.mjs usage
  node tools/wb2api.mjs test --model cn:hy3 --yes          # x0.00 免费模型，仍然要确认
  node tools/wb2api.mjs checkin                            # 会如实告诉你不可用`)
}

// ── 主流程 ────────────────────────────────────────────────────────────────
try {
  if (flag('help') || flag('h') || command === 'help') {
    printHelp()
    process.exit(0)
  }

  const config = loadConfig()
  const ctx = { origin: originOf(config.listen), apiKey: config.apiKey, config }
  console.log(line('='))
  console.log(`wb2api CLI · ${command} · gateway=${ctx.origin} · key=${ctx.apiKey === '' ? '(空 ⇒ 网关鉴权已关闭)' : `sha256:${fingerprint(ctx.apiKey)}`}`)
  console.log(line('='))

  const known = ['status', 'models', 'usage', 'test', 'checkin']
  if (!known.includes(command)) {
    console.error(`未知命令 ${command}`)
    console.error(`可用命令：${known.join(' · ')}　（node tools/wb2api.mjs --help 看用法）`)
    process.exit(2)
  }

  const code =
    command === 'status'
      ? await cmdStatus(ctx)
      : command === 'models'
        ? await cmdModels(ctx)
        : command === 'usage'
          ? await cmdUsage(ctx)
          : command === 'test'
            ? await cmdTest(ctx)
            : await cmdCheckin(ctx)

  console.log(line('='))
  process.exit(code)
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`用法错：${error.message}`)
    console.error('（node tools/wb2api.mjs --help 看用法）')
    process.exit(2)
  }
  console.error(`失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
