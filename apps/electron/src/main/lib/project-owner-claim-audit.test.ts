import { expect, test } from 'bun:test'
import type { OwnerClaimFacts, OwnerClaimMessage } from './project-owner-claim-audit'
import { claimsBackgroundWork, findOwnerClaimViolations, stripUnsupportedClaims } from './project-owner-claim-audit'

const CLAIMS = [
  '我正在内部复查原因，稍后会自动继续。',
  '后台正在处理人员安排，你不需要重复确认。',
  '补充核查：上次启动未完成，原因是授权过期。该启动意图已暂停自动重试；核对后可重新确认启动。',
  '已按你确认的结果与边界开始组织执行。我会在关键进展时继续在这里说明。',
  '本次失败发生在发送模型请求之前，没有产生模型费用。',
]
const CLAIM_ONLY = CLAIMS.slice(0, 2)

/** 穷举“说法 × 事实”的全部组合，断言只有“声称后台工作且没有任何后台事实”才判违规。 */
test('Given所有说法与事实组合 When穷举检查 Then只有无事实支撑的后台说法被标记', () => {
  const factSpace: OwnerClaimFacts[] = []
  for (const pendingEvents of [0, 1, 2]) {
    for (const runningExecutions of [0, 1]) {
      for (const awaitingUserDecisions of [0, 1]) factSpace.push({ pendingEvents, runningExecutions, awaitingUserDecisions })
    }
  }
  const messageSpace: OwnerClaimMessage[][] = [[], ...CLAIMS.map((content, index) => [{ role: 'assistant', kind: 'management_progress', content, createdAt: index }])]
  let checked = 0
  for (const facts of factSpace) {
    for (const messages of messageSpace) {
      const violations = findOwnerClaimViolations(messages, facts)
      const hasBackgroundWork = facts.pendingEvents > 0 || facts.runningExecutions > 0
      const expected = !hasBackgroundWork && messages.some(message => claimsBackgroundWork(message.content))
      expect({ facts, count: violations.length }).toEqual({ facts, count: expected ? messages.filter(message => claimsBackgroundWork(message.content)).length : 0 })
      checked++
    }
  }
  // 12 组事实 × 6 组消息：穷举覆盖而不是抽样。
  expect(checked).toBe(72)
})

test('Given等待用户决定 When检查说法 Then不把用户待决当成后台处理事实', () => {
  const facts: OwnerClaimFacts = { pendingEvents: 0, runningExecutions: 0, awaitingUserDecisions: 1 }
  const violations = findOwnerClaimViolations([{ role: 'assistant', kind: 'management_progress', content: CLAIM_ONLY[0]!, createdAt: 1 }], facts)
  expect(violations).toHaveLength(1)
})

test('Given用户自己的话包含同样说法 When检查 Then不判Owner编造', () => {
  const facts: OwnerClaimFacts = { pendingEvents: 0, runningExecutions: 0, awaitingUserDecisions: 0 }
  const violations = findOwnerClaimViolations([{ role: 'user', kind: 'goal', content: CLAIM_ONLY[0]!, createdAt: 1 }], facts)
  expect(violations).toHaveLength(0)
})

const NO_FACTS: OwnerClaimFacts = { pendingEvents: 0, runningExecutions: 0, awaitingUserDecisions: 0 }

test('Given没有后台事实 When剔除无依据说法 Then保留可核对部分并给出中性与替代说明', () => {
  const result = stripUnsupportedClaims('方案已经确认。我正在内部复查原因，稍后会自动继续。资料范围未变。', NO_FACTS)
  expect(result.removed).toHaveLength(1)
  expect(result.content).toBe('方案已经确认。资料范围未变。')
})

test('Given整段都是无依据说法 When剔除 Then用中性事实替代而不是留空', () => {
  const result = stripUnsupportedClaims('我正在内部复查，稍后自动继续。', NO_FACTS)
  expect(result.removed).toHaveLength(1)
  expect(result.content).toBe('当前没有正在进行的后台任务；具体状态以上面的记录为准。')
})

test('Given确有排队事实 When检查说法 Then不剔除也不改写', () => {
  const content = '我正在按已确认方案推进团队安排。'
  const result = stripUnsupportedClaims(content, { pendingEvents: 1, runningExecutions: 0, awaitingUserDecisions: 0 })
  expect(result).toEqual({ content, removed: [] })
})

test('Given普通说明或已结算说明 When检查 Then不误删', () => {
  const content = '本次失败发生在发送模型请求之前，没有产生模型费用。'
  expect(stripUnsupportedClaims(content, NO_FACTS)).toEqual({ content, removed: [] })
})
