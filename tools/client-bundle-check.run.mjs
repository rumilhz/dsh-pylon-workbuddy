/**
 * 浏览器半边离线闸门的**自我启动入口**（给 tools/_run-suites.mjs 用的一行套件）。
 *
 * 为什么要有这个文件，而不是让套件表直接跑 `tools/client-bundle-check.mjs`：
 * 套件表用 `existsSync(join(ROOT, entry))` 判入口在不在，而 `node_modules` 之外它只认
 * 仓库内的**相对**路径。这个文件就是那个相对路径 —— 它自己把真正的闸门跑起来。
 *
 * 它**不重新实现任何检查**：闸门还是 `tools/client-bundle-check.mjs` 那一支，输出原样
 * 透传，退出码原样透传。
 *
 *   <node> tools/client-bundle-check.run.mjs
 * 退出码：0 = 全过；1 = 有检查失败（含 `client/client.js` 不在这种坏检出）。
 * 哨兵 2 已废除 —— 见下面 CHECK 缺失那一支的说明。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dirname // Node ≥20.11；中文路径安全
const ROOT = join(HERE, '..')
const CHECK = join(ROOT, 'tools', 'client-bundle-check.mjs')

if (!existsSync(CHECK)) {
  // 闸门脚本自己也是仓库里的**源文件**，不是"没装的依赖"：它不在就是检出坏了。
  // 原来这里用哨兵 2（套件表会翻译成不影响退出码的 SKIP），与"卡片文件丢了"是同一个
  // 静默失效族，所以一并废掉，改成硬失败。
  console.log(`FAIL  ${CHECK} 不存在 —— 闸门脚本不在，检出是坏的`)
  process.exit(1)
}

const run = spawnSync(process.execPath, [CHECK, ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit', // 闸门的输出直接进本进程的终端，不缓存、不加工
  windowsHide: true,
})
process.exit(run.status === null ? 1 : run.status)
