/**
 * 启动就绪度与「下一步敲什么」的契约测试。
 *
 * ## 它钉住的是哪一次事故
 *
 * 2026-10-15 的「真·从零验证」（干净 `DSH_HOME` + 空 `wb2api/`）实测：插件在
 * 零凭据下启动时，boot.log 与 stdout **两个通道命中 0 条**指向前一步命令的指引；
 * 用户看到的是「provider 不存在，且写入 settings 失败」外加一段**建议他手写
 * provider** 的 YAML 块 —— 而真问题是网关没装/没登录。
 *
 * 因此这里有两条互相独立的断言线：
 *   ① {@link assessStartupReadiness} 的判据（什么算未就绪）；
 *   ② 文案与分场景（未就绪时说什么、以及**不再**说什么）。
 *
 * 判据与文案分开测，是为了让「沉默」也能被断言：就绪时必须**一行都不打** ——
 * 否则「未就绪」这个信号会在日志里失去意义。
 */

import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config.js'
import { renderSeedOutcome } from '../../src/index.js'
import type { SeedOutcome } from '../../src/provider-config.js'
import {
  assessStartupReadiness,
  renderReadinessNextSteps,
  type ReadinessFacts,
} from '../../src/startup-readiness.js'

/** 一份「全绿」的事实，用例只改需要的那几项。 */
function readyFacts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    binaryPath: 'C:\\Users\\x\\.dsh\\wb2api\\bin\\wb2a-server.exe',
    gatewayState: 'running',
    healthy: 1,
    enabledAccounts: 1,
    ...overrides,
  }
}

/** 从零的一台机器：二进制刚下好、网关起着、但一个账号都没有。 */
function zeroCredentialFacts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return readyFacts({ gatewayState: 'unhealthy', healthy: 0, enabledAccounts: 0, ...overrides })
}

describe('assessStartupReadiness 的判据', () => {
  it('全绿 ⇒ ready，且没有原因', () => {
    expect(assessStartupReadiness(readyFacts())).toEqual({ ready: true, blockers: [] })
  })

  it('🔴 零凭据（网关起着但 0 账号）⇒ 未就绪，原因点名「未登录」', () => {
    const readiness = assessStartupReadiness(zeroCredentialFacts())
    expect(readiness.ready).toBe(false)
    expect(readiness.blockers.map(blocker => blocker.short)).toEqual(['未登录'])
    expect(readiness.blockers[0]?.detail).toContain('auths/')
  })

  it('未安装 + 未登录 ⇒ **两条一起报**（不短路，免得修完一条再撞一次）', () => {
    const readiness = assessStartupReadiness({
      binaryPath: undefined,
      gatewayState: 'failed',
      healthy: undefined,
      enabledAccounts: 0,
    })
    expect(readiness.ready).toBe(false)
    expect(readiness.blockers.map(blocker => blocker.short)).toEqual(['未安装', '未登录'])
  })

  it('只有未安装时不额外报「网关未运行」—— 那是后果，不是第二个病因', () => {
    const readiness = assessStartupReadiness({
      binaryPath: undefined,
      gatewayState: 'failed',
      healthy: undefined,
      enabledAccounts: 3,
    })
    expect(readiness.blockers.map(blocker => blocker.short)).toEqual(['未安装'])
  })

  it('账号有、网关没跑 ⇒ 只报「网关未运行」', () => {
    const readiness = assessStartupReadiness(readyFacts({ gatewayState: 'stopped', healthy: undefined }))
    expect(readiness.blockers.map(blocker => blocker.short)).toEqual(['网关未运行'])
  })

  it('账号在冷却（healthy=0 但本地有启用凭证）⇒ **仍算就绪**（让人去登录是错的指引）', () => {
    expect(assessStartupReadiness(readyFacts({ healthy: 0, enabledAccounts: 2 })).ready).toBe(true)
  })

  it('凭证在别处（本地 0 个）但网关报出可用账号 ⇒ 仍算就绪', () => {
    expect(assessStartupReadiness(readyFacts({ enabledAccounts: 0, healthy: 2 })).ready).toBe(true)
  })

  it('网关状态 unknown（比如没托管）时按「没起来」处理', () => {
    const readiness = assessStartupReadiness(readyFacts({ gatewayState: undefined, healthy: undefined }))
    expect(readiness.blockers.map(blocker => blocker.short)).toEqual(['网关未运行'])
  })
})

describe('renderReadinessNextSteps 的文案', () => {
  it('就绪 ⇒ 空数组（沉默是判据的一部分）', () => {
    expect(renderReadinessNextSteps(assessStartupReadiness(readyFacts()))).toEqual([])
  })

  it('🔴 未就绪 ⇒ 原因 + 两条可直接照抄的命令（`/wb2api-setup` 与 `/wb2api-login cn`）', () => {
    const lines = renderReadinessNextSteps(assessStartupReadiness(zeroCredentialFacts()))
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('网关尚未就绪（未登录）')
    expect(lines[0]).toContain('请先执行')
    expect(lines[1]).toContain('/wb2api-setup')
    expect(lines[1]).toContain('一键安装')
    expect(lines[2]).toContain('/wb2api-login cn')
    expect(lines[2]).toContain('global')
  })

  it('两条原因同时出现时括号里一起写出来', () => {
    const lines = renderReadinessNextSteps(assessStartupReadiness({
      binaryPath: undefined, gatewayState: 'failed', healthy: undefined, enabledAccounts: 0,
    }))
    expect(lines[0]).toContain('网关尚未就绪（未安装 / 未登录）')
  })

  /**
   * ★ 2026-10-15：指引要**分病因**。
   *
   * 这两条钉住的是那次误判的**下游**：`probe()` 把「有监听但没回答」当成「端口无监听」，
   * 于是 `start()` 记成 `failed`，而就绪度只看到「网关状态 failed」⇒ 打出
   * 「请先执行 /wb2api-setup / /wb2api-login」—— 与真因无关（网关可能正在启动，
   * 重装重登都不会让它变快），而且这两条命令**都会去动网关**。
   *
   * 判据：端口那一类失败时，指引里必须出现「看状态 / 再试一次」，
   * 且**只有在真的缺安装或缺账号时**才允许出现 setup/login。
   */
  it('🔴 网关有监听但没应答（且账号齐全）⇒ 不再打「请先 /wb2api-setup」，改指看状态与重试', () => {
    const readiness = assessStartupReadiness(readyFacts({
      gatewayState: 'failed',
      healthy: undefined,
      enabledAccounts: 2,
      gatewayFailure: 'port-unresponsive',
    }))
    expect(readiness.blockers.map(blocker => blocker.short)).toEqual(['网关无响应'])
    const lines = renderReadinessNextSteps(readiness)
    expect(lines[0]).toContain('网关尚未就绪（网关无响应）')
    expect(lines.join('\n')).not.toContain('/wb2api-setup')
    expect(lines.join('\n')).not.toContain('/wb2api-login')
    expect(lines.join('\n')).toContain('/wb2api-status')
    expect(lines.join('\n')).toContain('/wb2api-start')
  })

  it('🔴 端口被别的程序占用 ⇒ 指「释放端口 / 改 baseURL」，同样不打 setup/login', () => {
    const readiness = assessStartupReadiness(readyFacts({
      gatewayState: 'failed',
      healthy: undefined,
      enabledAccounts: 2,
      gatewayFailure: 'port-foreign',
    }))
    expect(readiness.blockers.map(blocker => blocker.short)).toEqual(['端口被占用'])
    const lines = renderReadinessNextSteps(readiness)
    expect(lines.join('\n')).not.toContain('/wb2api-setup')
    expect(lines.join('\n')).toContain('baseURL')
  })

  it('「端口有服务」与「未登录」同时成立时，两条指引都给（先登录、同时别去重装）', () => {
    const readiness = assessStartupReadiness(readyFacts({
      gatewayState: 'failed',
      healthy: undefined,
      enabledAccounts: 0,
      gatewayFailure: 'port-unresponsive',
    }))
    expect(readiness.blockers.map(blocker => blocker.short)).toEqual(['未登录', '网关无响应'])
    const lines = renderReadinessNextSteps(readiness)
    // 真的没账号 ⇒ 通用那两行仍然要在（用户确实需要先登录）。
    expect(lines.join('\n')).toContain('/wb2api-login cn')
    // 但「网关在监听却不应答」这件事也必须说出来，且给出对应的下一步。
    expect(lines.join('\n')).toContain('/wb2api-status')
  })

  it('没有 lastFailure（如进程崩退）⇒ 保持旧文案「网关未运行」', () => {
    const readiness = assessStartupReadiness(readyFacts({ gatewayState: 'failed', healthy: undefined, enabledAccounts: 2 }))
    expect(readiness.blockers.map(blocker => blocker.short)).toEqual(['网关未运行'])
    expect(renderReadinessNextSteps(readiness).join('\n')).toContain('/wb2api-setup')
  })
})

describe('seed 失败文案的分场景（手工粘贴块该不该给）', () => {
  const config = resolveConfig({ providerName: 'workbuddy' })
  /** 真实形态：settings 拒绝了这次写入，但插件手里有一份可粘贴的 provider YAML。 */
  const writeFailed: SeedOutcome = {
    kind: 'failed',
    reason: 'write-failed',
    detail: 'llm-pi-ai: provider "workbuddy" resolves no models; the installed catalog does not describe this route',
    manualBlock: '    workbuddy:\n      apiKeyEnv: WORKBUDDY2API_API_KEY\n',
    notes: [],
  }

  it('🔴 网关未就绪 ⇒ **不打**「把下面这段贴进 profile」，改指下一步命令', () => {
    const text = renderSeedOutcome(writeFailed, config, { gatewayReady: false })
    expect(text).not.toContain('把下面这段贴进')
    expect(text).not.toContain('apiKeyEnv:')
    expect(text).toContain('/wb2api-setup')
    expect(text).toContain('/wb2api-login cn|global')
  })

  it('网关就绪 ⇒ 照旧给手工块（那是「网关正常、只有写入失败」的正确出口）', () => {
    const text = renderSeedOutcome(writeFailed, config, { gatewayReady: true })
    expect(text).toContain('把下面这段贴进')
    expect(text).toContain('apiKeyEnv: WORKBUDDY2API_API_KEY')
  })

  it('不传 options（`/wb2api-provider` 那条路）⇒ 保持旧行为，绝不静默吞掉手工块', () => {
    const text = renderSeedOutcome(writeFailed, config)
    expect(text).toContain('把下面这段贴进')
    expect(text).toContain('apiKeyEnv: WORKBUDDY2API_API_KEY')
  })

  it('别的失败分支（无手工块）不受影响', () => {
    const unreachable: SeedOutcome = {
      kind: 'failed',
      reason: 'gateway-unreachable',
      detail: '连续 3 次拉取 http://127.0.0.1:7863/v1/models 都失败：fetch failed',
      notes: [],
    }
    const text = renderSeedOutcome(unreachable, config, { gatewayReady: false })
    expect(text).toContain('拉不到网关模型目录')
    expect(text).toContain('/wb2api-provider --create')
  })
})
