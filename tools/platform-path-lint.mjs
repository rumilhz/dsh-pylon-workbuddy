/**
 * 期望值可移植性闸门：`tests/` 里的**期望值**不许写死路径分隔符。
 *
 *   <node> tools/platform-path-lint.mjs        有违规 ⇒ 退出码 1；干净 ⇒ 0
 *
 * ## 它防的是哪一类事故
 *
 * `tests/unit/write-guard.spec.ts` 里曾有一条
 * `expect(defaultBackupDir(home)).toBe(`${home}\\${BACKUP_DIR_NAME}`)` ——
 * 期望值是**用反斜杠字面量拼出来的**，被测函数用的却是 `path.join`。
 * 在 Windows 上两者恰好一致（都是 `\`），于是本地全绿；推到 CI 的 Linux 上，
 * `path.join` 产出 `/`，这条断言才第一次炸 —— 而它**第一次进 CI** 就已经是发布阻塞。
 * 这类缺陷的共同形状是：
 *
 *   期望值写成"我这台机器的分隔符" + 本地正是那台机器 ⇒ 本地永远发现不了。
 *
 * 所以判据不是"含不含反斜杠"，而是**期望值有没有由平台自己算出来**：
 * 只有当那个字面量**没有被** `join` / `resolve` 这类构造函数包着时，才算违规。
 * 这样 `expect(bootLogPath('C:\\home')).toBe(join('C:\\home', '.wb2api'))` 仍然合法 ——
 * 两个 `'C:\\home'` 都只是**入参**。
 *
 * ## 为什么用 AST 而不是 grep
 *
 * 一次 `grep '\\\\'` 在 tests/ 里有几十处命中，其中绝大多数是入参（假的 home、
 * 假的 binaryPath、假的 backupPath）—— 那些本来就不该改。一个会误报几十次的检查
 * 活不过一周。这里只认两件事：
 *   ① 命中点必须在 `expect(...).<匹配器>(...)` 的**期望值**位置；
 *   ② 该期望值里有一个含反斜杠的字符串/模板片段，且它不在路径构造函数里。
 *
 * ## 有意豁免：平台守卫
 *
 * 有些期望值**故意**断某一个平台的行为。只要那个用例里出现过 `process.platform`，
 * 就认为作者已经把它限定在某一个平台上，整段放行，并在汇总里点名 ——
 * 让"放行了什么"可见，而不是静默跳过。反过来，**没有守卫却假设了 Windows 行为**
 * 的期望值，正是要拦的东西。
 *
 * （本仓库现在没有这样的用例：与平台有关的 `process.platform` 只有两处 ——
 * `gateway-binary.spec.ts` 的默认目标、`login.spec.ts` 的 0600 权限位 —— 都不涉及分隔符。
 * Windows 专属的 OEM/GBK 解码与 taskkill/netstat 解析在 `tools/*-verify.mjs` 里，
 * 那是人工验证脚本，不是测试。）
 *
 * 反方向（期望值写死 `/` 却去比 `path.join` 的结果）不用这里管：那种写法在 Windows
 * 上就会红，本地基线自己会拦住它。
 *
 * ## 它先自检，再报 OK
 *
 * 这类闸门最坏的形态是**静默失效**：分类器哪天被改坏，它照样打印 "OK"，
 * 于是大家又回到"只有 CI 会告诉你"。所以每次运行都先拿一组内存里的样本来验分类器
 * （该报的、该放行的各来几条），对不上就直接红 —— 是 FAIL，不是 SKIP，
 * 理由是 `tools/_run-suites.mjs` 文件头那条教训：缺失的检查绝不能长得像通过的检查。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const HERE = import.meta.dirname // Node ≥20.11；中文路径安全（别用 new URL(...).pathname）
const ROOT = join(HERE, '..')
const TESTS = join(ROOT, 'tests')

/** 被视为"由平台算出路径"的调用：它们的**实参**不算写死的期望值。 */
const PATH_BUILDERS = new Set([
  'join', 'resolve', 'normalize', 'relative', 'dirname', 'basename',
  'extname', 'format', 'toNamespacedPath', 'parse',
])

/** 取期望值的匹配器（`expect(x)` 右侧那一次调用）。 */
const MATCHERS = new Set([
  'toBe', 'toEqual', 'toStrictEqual', 'toContain', 'toContainEqual', 'toMatch',
  'toMatchObject', 'toMatchInlineSnapshot', 'toThrow', 'toThrowError',
  'toHaveBeenCalledWith', 'toHaveBeenLastCalledWith', 'toHaveBeenNthCalledWith',
  'toSatisfy',
])

let ts
try {
  ts = await import('typescript')
} catch (error) {
  console.error(`无法加载 typescript（依赖没装？）：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1) // 绝不静默当成 PASS —— 见 tools/_run-suites.mjs 文件头规矩①
}
const T = ts.default ?? ts

const posix = (path) => relative(ROOT, path).split('\\').join('/')

/** 递归收集目录下某种后缀的文件（`.snap` 会进 `__snapshots__`，其余跳过后两者）。 */
function collect(dir, suffix, out = []) {
  if (!existsSync(dir)) return out
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name)
    if (item.isDirectory()) {
      if (item.name === '__snapshots__' || item.name === 'node_modules') {
        if (suffix === '.snap') collect(full, suffix, out)
        continue
      }
      collect(full, suffix, out)
    } else if (item.name.endsWith(suffix)) {
      out.push(full)
    }
  }
  return out
}

/** 一个节点是不是"拿着期望值"的那次调用（`expect(...)` 链上的匹配器）。 */
function matcherCall(node) {
  if (!T.isCallExpression(node)) return false
  const callee = node.expression
  if (!T.isPropertyAccessExpression(callee)) return false
  if (!MATCHERS.has(callee.name.text)) return false
  // 链上的 .not / .resolves / .rejects / .soft 挨个剥掉，看根是不是 expect(...)
  let receiver = callee.expression
  let guard = 0
  while (guard < 8 && T.isPropertyAccessExpression(receiver)) {
    if (!['not', 'resolves', 'rejects', 'soft'].includes(receiver.name.text)) return false
    receiver = receiver.expression
    guard += 1
  }
  if (T.isCallExpression(receiver)) {
    return T.isIdentifier(receiver.expression) && receiver.expression.text === 'expect'
  }
  return T.isIdentifier(receiver) && receiver.text === 'expect' // expect.soft(x).toBe(...)
}

/** `process.platform` 出现在里面就整段放行（作者已声明平台范围）。 */
function guardedRanges(sourceFile) {
  const ranges = []
  const visit = (node) => {
    if (T.isPropertyAccessExpression(node)
      && T.isIdentifier(node.expression) && node.expression.text === 'process'
      && node.name.text === 'platform') {
      let owner = node
      while (owner.parent !== undefined && !T.isFunctionLike(owner)) owner = owner.parent
      if (T.isFunctionLike(owner)) ranges.push([owner.getStart(sourceFile), owner.getEnd()])
    }
    T.forEachChild(node, visit)
  }
  visit(sourceFile)
  return ranges
}

/** 一个字符串/模板字面量的**值**里有没有真反斜杠（`'\n'` 这种转义不算）。 */
function backslashValue(node) {
  if (T.isStringLiteral(node) || T.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.includes('\\')
  }
  if (T.isTemplateExpression(node)) {
    if (node.head.text.includes('\\')) return true
    return node.templateSpans.some(span => span.literal.text.includes('\\'))
  }
  return false
}

/** 一次调用的名字（用来判断字面量是否被路径构造函数包着）。 */
function callName(node) {
  if (T.isPropertyAccessExpression(node)) return node.name.text
  if (T.isIdentifier(node)) return node.text
  return undefined
}

/**
 * 收集期望值子树里所有"含反斜杠、且不由路径构造函数产出"的字面量。
 * `insideBuilder` 一旦为真就整棵子树豁免 —— 字面量在那里只是入参。
 */
function offenders(node, insideBuilder, out = []) {
  if (T.isCallExpression(node) || T.isNewExpression(node)) {
    const name = callName(node.expression)
    const builder = insideBuilder || (name !== undefined && PATH_BUILDERS.has(name))
    for (const arg of node.arguments) offenders(arg, builder, out)
    return out
  }
  if (!insideBuilder && backslashValue(node)) out.push(node)
  // ⚠️ 回调必须**不返回值**：forEachChild 见到真值就停止遍历（返回数组同样是真值）。
  // 这里踩过：`child => offenders(...)` 让 toEqual({ home: 'C:\\x' }) 里的字面量被漏掉。
  T.forEachChild(node, (child) => { offenders(child, insideBuilder, out) })
  return out
}

/** 期望值里出现 `x.win32.<路径函数>` ⇒ 那条期望值天生只对一个平台成立。 */
function win32Built(node, found = []) {
  if (T.isPropertyAccessExpression(node) && node.name.text === 'win32') found.push(node)
  T.forEachChild(node, (child) => { win32Built(child, found) })
  return found
}

/** 扫一个已解析的 SourceFile，返回它的问题与豁免。 */
function scanSource(sourceFile) {
  const violations = []
  const exemptions = []
  let matchers = 0
  const guarded = guardedRanges(sourceFile)
  const isGuarded = (pos) => guarded.some(([from, to]) => pos >= from && pos < to)
  const at = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1

  const visit = (node) => {
    if (matcherCall(node)) {
      matchers += 1
      const line = at(node.expression.name)
      for (const arg of node.arguments) {
        const all = offenders(arg, false, [])
        const bad = all.filter(literal => !isGuarded(literal.getStart(sourceFile)))
        if (all.length > bad.length) exemptions.push({ line, count: all.length - bad.length })
        if (bad.length > 0) {
          violations.push({ line: at(bad[0]), kind: 'literal', sample: bad[0].getText(sourceFile).replace(/\s+/g, ' ').slice(0, 70), count: bad.length })
        }
        const w32 = win32Built(arg, [])
        if (w32.length > 0) {
          violations.push({ line: at(w32[0]), kind: 'win32', sample: w32[0].getText(sourceFile).slice(0, 70), count: w32.length })
        }
      }
    }
    T.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { violations, exemptions, matchers }
}

// ---------------------------------------------------------------- 先自检
// 分类器的样本：kind=null 表示**必须放行**。写成内存里的源码，不依赖任何文件。
const SELF_PROBES = [
  { label: '直接字面量', kind: 'literal', src: "expect(x).toBe('C:\\\\a\\\\b')" },
  { label: '模板拼出来的分隔符（本次事故的形状）', kind: 'literal', src: 'expect(x).toBe(`${home}\\\\${NAME}`)' },
  { label: 'toEqual 对象里的字面量', kind: 'literal', src: "expect(x).toEqual({ home: 'C:\\\\a', source: 'env' })" },
  { label: '嵌套里也要能挖到', kind: 'literal', src: "expect(x).toEqual([{ p: 'D:\\\\a\\\\b' }])" },
  { label: 'path.win32 显式构造', kind: 'win32', src: "expect(x).toBe(path.win32.join('a', 'b'))" },
  { label: 'join 构造（合法）', kind: null, src: "expect(x).toBe(join('C:\\\\a', 'b'))" },
  { label: 'resolve 构造（合法）', kind: null, src: "expect(x).toEqual({ p: resolve('C:\\\\a') })" },
  { label: '入参不受限（合法）', kind: null, src: "expect(f('C:\\\\a')).toBe(join('C:\\\\a', 'b'))" },
  { label: '平台守卫（放行）', kind: null, src: "it('w', () => { if (process.platform === 'win32') expect(x).toBe('C:\\\\a') })" },
  { label: '无守卫（拦）', kind: 'literal', src: "it('w', () => { expect(x).toBe('C:\\\\a') })" },
]

const selfFails = []
for (const probe of SELF_PROBES) {
  const sourceFile = T.createSourceFile('self.ts', probe.src, T.ScriptTarget.Latest, true, T.ScriptKind.TS)
  const { violations } = scanSource(sourceFile)
  const got = violations.length === 0 ? null : violations[0].kind
  if (got !== probe.kind) {
    selfFails.push(`${probe.label}：期望 ${probe.kind ?? '放行'}，实得 ${got ?? '放行'}  —— ${probe.src}`)
  }
}
if (selfFails.length > 0) {
  console.error('✗ 闸门自检失败：分类器已经不认这些形状了，本次 "OK" 不可信。')
  for (const row of selfFails) console.error(`    ${row}`)
  process.exit(1)
}

// ---------------------------------------------------------------- 扫仓库
const files = collect(TESTS, '.ts')
const snapshots = collect(TESTS, '.snap')
const violations = []
const exemptions = []
let matcherCount = 0

for (const file of files) {
  const sourceFile = T.createSourceFile(file, readFileSync(file, 'utf8'), T.ScriptTarget.Latest, true, T.ScriptKind.TS)
  const found = scanSource(sourceFile)
  matcherCount += found.matchers
  for (const row of found.violations) violations.push({ ...row, where: `${posix(file)}:${row.line}`, kind: row.kind })
  for (const row of found.exemptions) exemptions.push(`${posix(file)}:${row.line} (+${row.count})`)
}

for (const file of snapshots) {
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (line.includes('\\')) {
      violations.push({ where: `${posix(file)}:${index + 1}`, kind: 'snapshot', sample: line.trim().slice(0, 70), count: 1 })
    }
  })
}

console.log('期望值可移植性闸门（tests/ 的期望值不许写死路径分隔符）')
console.log(`自检 ${SELF_PROBES.length} 条样本通过 · 扫描 ${files.length} 个 .ts · ${matcherCount} 处期望值 · 快照 ${snapshots.length} 份`)
for (const row of exemptions) console.log(`  · 已按 process.platform 守卫放行：${row}`)

if (violations.length === 0) {
  console.log('OK：没有"没写平台守卫、却把分隔符写死在期望值里"的断言。')
  console.log('说明：入参（假的 home / binaryPath / backupPath）不受限制；期望值请用 join/resolve 构造。')
  process.exit(0)
}

const HINTS = {
  literal: '期望值含字面反斜杠 ⇒ 改成 join(...)/resolve(...) 构造，让平台自己决定分隔符',
  win32: '期望值由 path.win32 显式构造 ⇒ 只对一个平台成立，请加 process.platform 守卫或改用法一致的构造',
  snapshot: '快照里含反斜杠 ⇒ 换台机器就对不上，先把路径用 join/normalize 归一化再落快照',
}

console.log('')
for (const row of violations) {
  console.log(`✗ ${row.where}  [${row.kind}${row.count > 1 ? ` ×${row.count}` : ''}]`)
  console.log(`    ${row.sample}`)
  console.log(`    ${HINTS[row.kind]}`)
}
console.log('')
console.log(`${violations.length} 处违规。理由见本文件头：期望值必须由平台自己算出来，`)
console.log('否则"本地正是这台机器"会一直替你掩盖它在别的平台上会红这件事。')
process.exit(1)
