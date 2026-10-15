/**
 * 「网关实际读哪个 `auths/` 目录」的**唯一**推导处。
 *
 * ## 为什么必须只有一处
 *
 * 这个路径有三个消费者，任何一个走偏都会造成**不报错的错**：
 *
 * 1. `AccountStore.authDir()` —— 登录写入、账号启用/禁用的改名目标；
 * 2. `GatewaySupervisor.countAuthFiles()` —— 「网关起来了但没有账号」提示里的数字；
 * 3. 网关进程自己 —— 它按 `cwd` + `config.json` 的 `auth_dir` 真去读凭证。
 *
 * 三者只要有一个不一致，症状都是**静默**的：
 *
 * · 登录写进了 A 目录、网关读 B 目录 ⇒ 账号"登录成功"但一直不可用；
 * · 诊断数字数的是 A 目录、而网关读 B ⇒ 提示「0 个凭证文件」却其实有账号，
 *   把人指到一个空目录去排查。
 *
 * 2026-10-15 实测的正是第二种：`countAuthFiles()` 固定拼 `<基准>/auths`，
 * **不读** `config.json` 的 `auth_dir`，而用户一旦把 `auth_dir` 改成 `./creds`，
 * 那个出现在报错文案里的数字就恒为 0。
 *
 * ## 基准目录的顺序（与 `GatewaySupervisor.resolveWorkingDir()` 一致）
 *
 * `workingDir` → `repoPath` → 插件运行目录（`<DSH home>/wb2api`，**且只有那里
 * 存在 `config.json` 时**才算数）→ 当前工作目录。
 *
 * 那个 `config.json` 的存在性判断不能省：网关的配置是**相对 cwd** 的，
 * 而 `resolveWorkingDir()` 也正是用这个判据决定「网关会不会在那个目录里跑」。
 * 少了它，一个在别处（`repoPath` / 用户自己的 cwd）跑的网关会被我们改到
 * 插件运行目录里的凭证上 —— 同样不报错，但账号换不动。
 *
 * 目录名本身读 `config.json` 的 `auth_dir`（相对基准目录解析），
 * 缺失 / 不是 JSON / 字段为空时回退 `./auths`。
 *
 * @module dsh-pylon-workbuddy/auth-dir
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { GatewayPluginConfig } from './config.js'
import { CONFIG_NAME, defaultRuntimeDir } from './gateway-binary.js'

/**
 * 推导网关实际使用的 `auths/` 目录（绝对路径）。
 *
 * @param config - 插件配置（只用到 `workingDir` / `repoPath`）。
 * @returns 凭证目录绝对路径；推导不出基准目录时按 `resolve('./auths')`（当前工作目录）。
 */
export function resolveAuthDir(config: GatewayPluginConfig): string {
  const { repoPath, workingDir } = config
  const runtime = defaultRuntimeDir()
  const base = workingDir !== ''
    ? workingDir
    : repoPath !== ''
      ? repoPath
      : existsSync(join(runtime, CONFIG_NAME)) ? runtime : ''
  // config.json 的读取位置与基准目录一致：两处都看同一个文件，避免"目录用 A、配置读 B"。
  const configRoot = base !== '' ? base : repoPath
  let authDir = './auths'
  if (configRoot !== '') {
    const configFile = join(configRoot, CONFIG_NAME)
    try {
      if (existsSync(configFile)) {
        const parsed = JSON.parse(readFileSync(configFile, 'utf8')) as { auth_dir?: unknown }
        if (typeof parsed.auth_dir === 'string' && parsed.auth_dir !== '') authDir = parsed.auth_dir
      }
    } catch {
      // 忽略：网关 config.json 不存在或不是 JSON 时按默认 ./auths 处理。
    }
  }
  return base === '' ? resolve(authDir) : resolve(base, authDir)
}
