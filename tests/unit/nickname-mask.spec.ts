/**
 * 昵称脱敏：`/status.nickname` 在本 build 里**就是手机号**（实测形如 `18612345617`），
 * 而它出现在 `/wb2api-status` 的账号列表、账号选择弹窗、登录回执里 —— 全是会被人看到的地方。
 *
 * 这条规则的难点**不在打码，而在"不要多打"**：`describeSelection` / 账号弹窗靠昵称区分账号，
 * 一律糊成 `***` 等于把账号列表变成一串无法辨认的星号。所以这里测的是**边界**：
 * 手机号必须打，非手机号必须**一个字符都不动**（含空串、含带空白的形态）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { maskNickname } from '../../src/index.js'

describe('昵称脱敏 maskNickname', () => {
  it('中国大陆手机号 ⇒ 前 3 + **** + 后 4', () => {
    expect(maskNickname('18612345617')).toBe('186****5617')
    // 打码后长度不变（11），账号列表的对齐/列宽不会被撑破。
    expect(maskNickname('18612345617')).toHaveLength(11)
    expect(maskNickname('13800000000')).toBe('138****0000')
    expect(maskNickname('19999999999')).toBe('199****9999')
  })

  it('英文名 / 真昵称 ⇒ 原样保留（一律打码会让账号列表失去可辨识性）', () => {
    for (const name of ['alice', 'Alice Wang', '张三', 'wang.lei@corp', '1861234567', '186123456789']) {
      expect(maskNickname(name)).toBe(name)
    }
  })

  it('空串 ⇒ 空串（调用方自己把它渲染成 (无昵称)，这里不该越权改写）', () => {
    expect(maskNickname('')).toBe('')
  })

  it('恰好 11 位但非 1 开头 ⇒ 不动', () => {
    for (const name of ['28612345617', '08612345617', '98612345617', 'a8612345617']) {
      expect(maskNickname(name)).toBe(name)
    }
  })

  it('带空格 ⇒ 首尾空白也照样识别并打码（网关换个序列化就可能带上）', () => {
    // 命中：trim 后是合法手机号 ⇒ 输出打码结果（不带首尾空白）。
    expect(maskNickname(' 18612345617 ')).toBe('186****5617')
    expect(maskNickname('\t18612345617\n')).toBe('186****5617')
    // 不命中：**原样返回，连空白都不动** —— "脱敏"不该顺手改写别的显示内容。
    expect(maskNickname(' alice ')).toBe(' alice ')
    expect(maskNickname('   ')).toBe('   ')
    // 数字内部有空格 ⇒ 不是 /^1\d{10}$/ 的形状，按"其余昵称"处理。
    expect(maskNickname('186 1234 5617')).toBe('186 1234 5617')
  })

  it('打码结果自身再脱敏是幂等的（重复渲染不会越打越花）', () => {
    expect(maskNickname(maskNickname('18612345617'))).toBe('186****5617')
  })
})

/**
 * 廉价回归网：**新建的输出点不许漏掉脱敏**。
 *
 * 为什么需要它：`describeAccount` / `describeSelection` 这些渲染函数没有导出，没有便宜的
 * 行为入口可以断言；而这次泄漏之所以发生，恰恰是"某处新加了一行 `account.nickname`"。
 * 只测 `maskNickname` 本身挡不住下一次同样的漏 —— 函数是对的，没被接上去而已。
 *
 * **它证明的是"这两个文件里没有任何一处裸用 nickname"，不是"输出一定脱敏"**：
 * 先把昵称赋给局部变量、再在别处打印，这张网就漏得过去。它挡的是最常见的那种写法。
 *
 * 白名单只有一条：类型声明 `nickname?: unknown`（它不渲染任何东西）。
 */
describe('输出点不许漏脱敏（源码约定）', () => {
  const MODULES = ['src/index.ts', 'src/setup.ts']
  const ROOT = join(import.meta.dirname, '..', '..')

  /** 去掉块注释与行注释 —— 文档里提到 nickname 是正常的，不该触发失败。 */
  const stripComments = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  for (const module of MODULES) {
    it(`${module}：每一处 nickname 都包在 maskNickname 里`, () => {
      const offenders = stripComments(readFileSync(join(ROOT, module), 'utf8'))
        .split(/\r?\n/)
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(row => row.line.includes('nickname'))
        .filter(row => !row.line.includes('maskNickname'))
        .filter(row => !/^nickname\?:/.test(row.line)) // 类型声明：不渲染

      expect(offenders.map(row => `${module}:${row.number}: ${row.line}`)).toEqual([])
    })
  }

  it('这两个模块确实把昵称渲染出来了（否则上面那条网是空转的）', () => {
    // 防"白名单把整条断言吃干净"：至少各有一处真的用了 maskNickname。
    for (const module of MODULES) {
      const code = stripComments(readFileSync(join(ROOT, module), 'utf8'))
      expect(code.split('maskNickname').length - 1, `${module} 里没有 maskNickname 调用`).toBeGreaterThanOrEqual(2)
    }
  })
})
