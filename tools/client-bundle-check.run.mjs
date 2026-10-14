/**
 * 浏览器半边离线闸门的**自我启动入口**（给 tools/_run-suites.mjs 用的一行套件）。
 *
 * 为什么要有这个文件，而不是让套件表直接跑 `tools/client-bundle-check.mjs`：
 * 套件表用 `existsSync(join(ROOT, entry))` 判入口在不在，而 `node_modules` 之外它只认
 * 仓库内的**相对**路径。这个文件就是那个相对路径 —— 它自己把真正的闸门跑起来。
 *
 * 它**不重新实现任何检查**：闸门还是 `tools/client-bundle-check.mjs` 那一支，输出原样
 * 透传，退出码原样透传（包括闸门用来表示"我没跑"的哨兵 2）。
 *
 *   <node> tools/client-bundle-check.run.mjs
 * 退出码：0 = 全过；1 = 有检查失败；2 = 闸门自报未运行（比如 lib/client.js 不在）
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dirname // Node ≥20.11；中文路径安全
const ROOT = join(HERE, '..')
const CHECK = join(ROOT, 'tools', 'client-bundle-check.mjs')

if (!existsSync(CHECK)) {
  // 缺入口是"这条没跑"，不是"这条过了"，所以用哨兵 2 而不是 0 或 1。
  console.log(`SKIP  ${CHECK} 不存在 —— 浏览器半边还没落地？`)
  process.exit(2)
}

const run = spawnSync(process.execPath, [CHECK, ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit', // 闸门的输出直接进本进程的终端，不缓存、不加工
  windowsHide: true,
})
process.exit(run.status === null ? 1 : run.status)
