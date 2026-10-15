/**
 * 探活停顿注入器（验收器材，仓库外）：把本进程里的**全局 fetch** 包一层固定延迟。
 *
 *   NODE_OPTIONS="--require <此文件>"  WB2API_STALL_MS=3200  <vitest 命令>
 *
 * 为什么需要它：`probe()` 现在把「任何 fetch 异常（含 healthTimeoutSeconds 超时）」
 * 都当成「端口无监听」。那条偶发红的用例（503 但响应体不是本网关）之所以会红，
 * 就是**某次 loopback 往返超过了 3 秒**（CI runner 卡顿 / 杀软过滤 / WSL 中继 …）。
 * 本机 16 核压满也只有 ~86ms，ambient 复现不出来（15 次全套 0 红）—— 于是用这个
 * 注入器把那个停顿**变成必然**：延迟发生在 fetch 真正发起**之前**，所以 3 秒的
 * `AbortSignal.timeout` 到点时，请求才刚出去 ⇒ 100% 落在 timeout 分支。
 *
 * ★ 它是**环境**注入（不碰任何测试文件、不碰 src），所以「修前 / 修后」两次测量
 *   跑的是同一份代码路径，差别只有仓库里的改动本身。
 * ★ 只加延迟，不改任何其它语义；不设 WB2API_STALL_MS 时它什么都不做。
 */
const stallMs = Number(process.env['WB2API_STALL_MS'] ?? '0')

if (Number.isFinite(stallMs) && stallMs > 0 && typeof globalThis.fetch === 'function') {
  const original = globalThis.fetch
  globalThis.fetch = async (...args) => {
    await new Promise((resolve) => { setTimeout(resolve, stallMs) })
    return await original(...args)
  }
  // 让"注入器到底装上了没有"可见（否则一次没生效的注入会被读成"修好了"）。
  process.on('exit', () => {
    if (process.env['WB2API_STALL_VERBOSE'] === '1') process._rawDebug(`[stall-fetch] +${stallMs}ms applied`)
  })
}
