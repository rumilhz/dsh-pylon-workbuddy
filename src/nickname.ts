/**
 * 昵称脱敏 —— 单独成模块，而不是塞进 `index.ts` 或 `setup.ts`。
 *
 * 理由是**两处都要用**：`index.ts`（`/wb2api-status` 的账号列表、账号选择弹窗、登录回执）
 * 与 `setup.ts`（`/wb2api-setup` 的逐步骤汇报）都会把昵称渲染给人看。而 `index.ts`
 * 本来就 `import { renderSetupReport, SetupRunner } from './setup.js'` —— 若把函数放在
 * `index.ts`、再由 `setup.ts` 反向 import，就成了 `index → setup → index` 的循环。
 * ESM 下函数声明靠提升**确实**能转起来，但那是"恰好能跑"，不是"设计如此"：
 * `setup.ts` 至今只 import 类型，这份独立性值得保住。
 *
 * @module dsh-pylon-workbuddy/nickname
 */

/**
 * 手机号形态的昵称（**实测**：本 build 的 `/status.nickname` 就是手机号，形如 `18612345617`）。
 *
 * 锚定 11 位纯数字、首位 `1`；`test` 前先 `trim()`，所以 `" 18612345617 "` 这种
 * 带首尾空白的形态也照样命中（网关换个 JSON 序列化就可能带上）。
 */
const PHONE_LIKE_NICKNAME = /^1\d{10}$/

/**
 * 昵称脱敏：**只打码手机号形态，其余一律原样返回**。
 *
 * 为什么不一律打码：`/wb2api-status`、账号选择弹窗、`/wb2api-setup` 都靠昵称区分账号，
 * 把英文名和真昵称也糊成 `***` 等于让账号列表失去可辨识性 —— 而那些形态本来就不构成
 * 隐私风险（风险来自「昵称字段里装的是手机号」这一件事，且**只在部分机器上成立**：
 * 本机实测是手机号，别人机器未必）。同理，**非手机号的入参连首尾空白都不动**，
 * 免得"脱敏"顺手改写了别的显示内容。
 *
 * 打码后仍是 11 字符（`186****5617`），所以列表对齐不会被撑破；且对自身幂等。
 *
 * @param nickname - `/status.nickname`（`AuthAccount.nickname`）原值。
 * @returns 手机号 ⇒ 前 3 位 + `****` + 后 4 位；其余 ⇒ `nickname` 原值（含空串）。
 */
export function maskNickname(nickname: string): string {
  const digits = nickname.trim()
  return PHONE_LIKE_NICKNAME.test(digits)
    ? `${digits.slice(0, 3)}****${digits.slice(-4)}`
    : nickname
}
