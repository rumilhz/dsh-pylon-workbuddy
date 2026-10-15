/**
 * `/wb2api-provider` 的参数解析。
 *
 * 单独一条用例的理由：**三个开关的代价完全不同，而它们的拼写只差几个字符** ——
 * `--create` 从不改写、`--rebuild` 只增不删、`--rebuild --reset` 会把用户在模型页
 * 做的筛选整份覆盖掉。把「用户到底敲了哪个」交给一个可断言的纯函数，比在注释里
 * 叮嘱「小心别写错」可靠。
 */

import { describe, expect, it } from 'vitest'
import { parseProviderCommandArgs } from '../../src/index.js'

describe('parseProviderCommandArgs', () => {
  it('什么都不敲 ⇒ 三个开关都是 false（只读那条路）', () => {
    expect(parseProviderCommandArgs('')).toEqual({ create: false, rebuild: false, reset: false })
    expect(parseProviderCommandArgs('   ')).toEqual({ create: false, rebuild: false, reset: false })
  })

  it('--rebuild 只有它自己：只增不删（reset 必须是 false）', () => {
    expect(parseProviderCommandArgs('--rebuild')).toEqual({ create: false, rebuild: true, reset: false })
  })

  it('★ --rebuild --reset：整份覆盖那条路', () => {
    expect(parseProviderCommandArgs('--rebuild --reset')).toEqual({ create: false, rebuild: true, reset: true })
    expect(parseProviderCommandArgs('--reset --rebuild')).toEqual({ create: false, rebuild: true, reset: true })
    expect(parseProviderCommandArgs('  --rebuild   --reset  ')).toEqual({ create: false, rebuild: true, reset: true })
  })

  it('★ 只敲 --reset 也生效（隐含 --rebuild）：破坏性操作不该因为少打一个词变成「没反应」', () => {
    expect(parseProviderCommandArgs('--reset')).toEqual({ create: false, rebuild: true, reset: true })
  })

  it('--create 与其它开关可以并存，且它自己不带覆盖语义', () => {
    expect(parseProviderCommandArgs('--create')).toEqual({ create: true, rebuild: false, reset: false })
    expect(parseProviderCommandArgs('--create --rebuild')).toEqual({ create: true, rebuild: true, reset: false })
  })

  it('🔴 只有**整词**才算：前缀/后缀/大小写变体都不许触发（尤其不许触发覆盖）', () => {
    for (const raw of ['--resetx', 'x--reset', '--resett', 'reset', '--RESET', '--Reset', '--rebuildx', '--creates']) {
      expect(parseProviderCommandArgs(raw), raw).toEqual({ create: false, rebuild: false, reset: false })
    }
    // 混在别的词里也不许误判。
    expect(parseProviderCommandArgs('--rebuild --reset=false')).toEqual({ create: false, rebuild: true, reset: false })
  })
})
