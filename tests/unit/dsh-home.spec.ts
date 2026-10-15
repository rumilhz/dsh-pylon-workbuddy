/**
 * 「DSH home 口径」的契约测试：`DSH_HOME` → `~/.dsh`。
 *
 * ## 为什么这一条值得单独一个文件
 *
 * 网关的**三样东西**全都以 DSH home 为基准：二进制安装目录、运行目录
 * （`config.json` / `auths/`）、以及 `AccountStore` 找 `auths/` 时的兜底基准。
 * 它们原先各自写了 `homedir()/.dsh/wb2api`，于是出现了一种最难查的形态：
 *
 * ```
 * DSH_HOME=<临时 home> dsh …      ← 轨迹/墓碑落在临时 home（看起来「隔离成功」）
 *                                   网关二进制与凭证却写进活体 ~/.dsh/wb2api
 * ```
 *
 * （2026-10-15「真·从零验证」实测到的正是这一条：任何干净 home 验证都必须显式覆盖
 * `binaryPath`/`workingDir` 才不会写活体。）
 *
 * 本文件把两件事钉死，避免以后有人只改其中一处：
 *   ① **设了 `DSH_HOME`** ⇒ 上面三处**整体**跟着走；
 *   ② **没设** ⇒ 逐字等于旧行为（`~/.dsh`），活体用户行为不变。
 *
 * 环境变量的改写一律 try/finally 还原：`process.env` 是进程级的，漏还原会污染同一
 * 文件里的后续用例（vitest 默认一个文件一个 worker，跨文件不会串）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { AccountStore } from '../../src/accounts.js'
import { DEFAULT_CONFIG, resolveConfig } from '../../src/config.js'
import { defaultInstallDir, defaultRuntimeDir } from '../../src/gateway-binary.js'
import { GatewaySupervisor } from '../../src/gateway-supervisor.js'
import { dshHome, resolveDshHome } from '../../src/plugin-state.js'

const DSH_HOME_KEY = 'DSH_HOME'
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const created: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言。
    }
  }
})

/** 在「临时设一个 DSH_HOME」的作用域里跑一段断言，退出时无条件还原。 */
async function withDshHome(value: string | undefined, body: () => void | Promise<void>): Promise<void> {
  const previous = process.env[DSH_HOME_KEY]
  try {
    if (value === undefined) delete process.env[DSH_HOME_KEY]
    else process.env[DSH_HOME_KEY] = value
    await body()
  } finally {
    if (previous === undefined) delete process.env[DSH_HOME_KEY]
    else process.env[DSH_HOME_KEY] = previous
  }
}

/** 造一个只会在 PATH 上失败的假 subprocess 服务（逼 supervisor 走目录查找）。 */
function makeSubprocess(): SubprocessRuntime {
  return {
    resolveExecutable: async (command: string) => { throw new Error(`not found: ${command}`) },
    terminalEnvironment: async () => ({ platform: 'windows' as const }),
    spawn: () => { throw new Error('unused') },
    spawnTerminal: async () => { throw new Error('unused') },
  } as unknown as SubprocessRuntime
}

/** 一个「插件自己管运行目录」的配置：显式项全空 ⇒ 基准必然落到 home 口径上。 */
function managedConfig(): ReturnType<typeof resolveConfig> {
  return resolveConfig({ binaryPath: '', repoPath: '', workingDir: '' })
}

/** 造一个 `<home>/wb2api/`（含 config.json + auths/）并返回运行目录。 */
function seedRuntime(home: string): string {
  const runtime = join(home, 'wb2api')
  mkdirSync(join(runtime, 'auths'), { recursive: true })
  writeFileSync(join(runtime, 'config.json'), JSON.stringify({ auth_dir: './auths' }))
  return runtime
}

describe('resolveDshHome（唯一的 home 口径）', () => {
  it('DSH_HOME 非空 ⇒ 直接用它（不再看 os.homedir）', () => {
    // 期望值取自**同一个来源**（入参本身），而不是重抄一遍字面量 ——
    // 这条断的是「逐字返回」，与分隔符无关，重抄字面量只会凭空引入平台假设。
    const isolated = 'D:\\iso\\home'
    expect(resolveDshHome({ env: { DSH_HOME: isolated }, homedir: () => 'C:\\Users\\nobody' }))
      .toBe(isolated)
  })

  it('DSH_HOME 缺失或只有空白 ⇒ 退回 `~/.dsh`（DSH 自己的默认值）', () => {
    expect(resolveDshHome({ env: {}, homedir: () => 'C:\\Users\\nobody' }))
      .toBe(join('C:\\Users\\nobody', '.dsh'))
    expect(resolveDshHome({ env: { DSH_HOME: '   ' }, homedir: () => 'C:\\Users\\nobody' }))
      .toBe(join('C:\\Users\\nobody', '.dsh'))
  })

  it('连 os.homedir 都拿不到 ⇒ undefined（调用方降级，不抛错）', () => {
    expect(resolveDshHome({ env: {}, homedir: () => undefined })).toBeUndefined()
    expect(resolveDshHome({ env: {}, homedir: () => { throw new Error('no home') } })).toBeUndefined()
  })

  it('dshHome()（字符串版）跟着 DSH_HOME 走，空白值不认', async () => {
    const isolated = 'D:\\iso\\home'
    await withDshHome(isolated, () => { expect(dshHome()).toBe(isolated) })
    await withDshHome('   ', () => { expect(dshHome()).toBe(join(homedir(), '.dsh')) })
    await withDshHome(undefined, () => { expect(dshHome()).toBe(join(homedir(), '.dsh')) })
  })
})

describe('网关安装目录 / 运行目录的基准', () => {
  it('没设 DSH_HOME ⇒ 逐字等于旧行为 `~/.dsh/wb2api{,/bin}`', async () => {
    await withDshHome(undefined, () => {
      expect(defaultRuntimeDir()).toBe(join(homedir(), '.dsh', 'wb2api'))
      expect(defaultInstallDir()).toBe(join(homedir(), '.dsh', 'wb2api', 'bin'))
    })
  })

  it('🔴 设了 DSH_HOME ⇒ 两处整体跟着走（否则二进制会被装进活体 home）', async () => {
    const home = tempDir('wb2a-home-')
    await withDshHome(home, () => {
      expect(defaultRuntimeDir()).toBe(join(home, 'wb2api'))
      expect(defaultInstallDir()).toBe(join(home, 'wb2api', 'bin'))
      // 反例：任何一处仍然拼出 `<真实 home>/.dsh` 都会让隔离验证前功尽弃。
      expect(defaultInstallDir().startsWith(join(homedir(), '.dsh'))).toBe(false)
      expect(defaultRuntimeDir().startsWith(join(homedir(), '.dsh'))).toBe(false)
    })
  })
})

describe('GatewaySupervisor 的第 3 查找位（插件自己的安装落点）', () => {
  it('🔴 跟着 DSH_HOME 走：隔离 home 里的网关能被找到', async () => {
    const home = tempDir('wb2a-home-')
    const binDir = join(home, 'wb2api', 'bin')
    mkdirSync(binDir, { recursive: true })
    const binary = join(binDir, 'wb2a-server.exe')
    writeFileSync(binary, 'placeholder')

    await withDshHome(home, async () => {
      const supervisor = new GatewaySupervisor({ config: managedConfig(), subprocess: makeSubprocess(), logger: silentLogger })
      await expect(supervisor.resolveBinary()).resolves.toBe(binary)
    })
  })

  it('没设 DSH_HOME ⇒ 不会去读那个临时 home（仍只认 `~/.dsh/wb2api/bin` 与 PATH）', async () => {
    const home = tempDir('wb2a-home-')
    const binDir = join(home, 'wb2api', 'bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'wb2a-server.exe'), 'placeholder')

    await withDshHome(undefined, async () => {
      const supervisor = new GatewaySupervisor({ config: managedConfig(), subprocess: makeSubprocess(), logger: silentLogger })
      // 这台机器上 `~/.dsh/wb2api/bin` 可能真有一个二进制（开发机就是），
      // 所以断言的是「**不会**落到那个临时 home 里」而不是「必然抛错」。
      try {
        const resolved = await supervisor.resolveBinary()
        expect(resolved.startsWith(join(home, 'wb2api'))).toBe(false)
      } catch (error) {
        expect(error instanceof Error).toBe(true)
        expect((error as Error).message).toContain('未找到网关可执行文件')
      }
    })
  })
})

describe('AccountStore.authDir 的兜底基准', () => {
  it('🔴 跟着 DSH_HOME 走：隔离 home 里那份 config.json 的 auths/ 才是要改的目录', async () => {
    const home = tempDir('wb2a-home-')
    const runtime = seedRuntime(home)

    await withDshHome(home, () => {
      const store = new AccountStore({ config: { ...DEFAULT_CONFIG, repoPath: '', workingDir: '' }, logger: silentLogger })
      expect(store.authDir()).toBe(join(runtime, 'auths'))
      expect(store.authDir().startsWith(join(homedir(), '.dsh'))).toBe(false)
    })
  })

  it('workingDir 显式给了就不用 home 兜底（用户自己管网关目录）', async () => {
    const home = tempDir('wb2a-home-')
    const own = tempDir('wb2a-own-')
    mkdirSync(join(own, 'auths'), { recursive: true })
    writeFileSync(join(own, 'config.json'), JSON.stringify({ auth_dir: './auths' }))

    await withDshHome(home, () => {
      const store = new AccountStore({ config: { ...DEFAULT_CONFIG, workingDir: own }, logger: silentLogger })
      expect(store.authDir()).toBe(join(own, 'auths'))
    })
  })

  it('没设 DSH_HOME ⇒ 基准回到 `~/.dsh/wb2api`（旧行为；那里没有 config.json 时才退回 cwd）', async () => {
    await withDshHome(undefined, () => {
      const store = new AccountStore({ config: { ...DEFAULT_CONFIG, repoPath: '', workingDir: '' }, logger: silentLogger })
      const expected = join(homedir(), '.dsh', 'wb2api', 'auths')
      // 两种合法结局：本机有活体运行目录 ⇒ 用它；没有 ⇒ `resolve('./auths')`（cwd 基准）。
      expect([expected, resolve('./auths')]).toContain(store.authDir())
    })
  })
})
