import { expect, test } from 'bun:test'
import { findOwnerDeliveredRosterConflict, findOwnerRosterScenarioConflict } from './project-owner-roster-scenario'

const goal = {
  projectId: 'project', goalVersion: 1, constraints: [], acceptanceCriteria: [],
  objective: '交付 manual/handbook.md，写出一个迟到与候补同时到场的示例并核对时间和人数。',
}
const example = [
  '## 五、迟到与候补流程示例',
  '已报名者「张三」14:06 到场；现场候补「李四」14:06 到场。',
  '签到表显示截至 14:05 到场 11 人，缺席 1 人（「王五」未到场）。',
  '14:06：张三为已报名者，但其席位已在 14:05 释放。',
].join('\n')
const artifact = (newContent: string, path = 'manual/handbook.md') => ({
  fileSnapshot: true as const, content: JSON.stringify({ files: [{ file: { path }, newContent }] }),
})

test('Given候补示例同时声明唯一缺席者和另一位晚到报名者 When核对原件 Then指出两个身份并拒绝放行', () => {
  expect(findOwnerDeliveredRosterConflict(goal, [artifact(example)])).toContain('14:05 的唯一缺席者是「王五」，但另一位已报名者「张三」到 14:06 才到场')
  expect(findOwnerDeliveredRosterConflict(goal, [artifact(example.replace('王五', '张三'))])).toBeNull()
})

test('Given其余文档、其他示例或代码围栏中的文字 When核对 Then不把它们合成当前示例的冲突', () => {
  expect(findOwnerDeliveredRosterConflict(goal, [artifact(example, 'notes.md')], false)).toBeNull()
  expect(findOwnerDeliveredRosterConflict(goal, [artifact(example, 'notes.md')])).toContain('Markdown 原件')
  expect(findOwnerRosterScenarioConflict(goal, example.replace('签到表', '## 另一情境\n签到表'))).toBeNull()
  expect(findOwnerRosterScenarioConflict(goal, example.replace('缺席 1 人', '缺席 2 人'))).toBeNull()
  expect(findOwnerRosterScenarioConflict(goal, example.replace('已报名者', '迟到者'))).toBeNull()
  expect(findOwnerRosterScenarioConflict(goal, example.replace('已报名者', '未报名者'))).toBeNull()
  expect(findOwnerRosterScenarioConflict(goal, ['```md', example, '```'].join('\n'))).toBeNull()
})

test('Given两分钟确认从14:05开始 When14:06把候补计入满员名单 Then独立核对发现占位早于确认', () => {
  const timing = [
    '## 迟到者与候补同时到场的示例',
    '2. 14:05：递补窗口开启。志愿者 A 按顺序联系候补 1 号，用时 2 分钟（≤3 分钟）确认入场，确认人数 11/12。',
    '4. 14:06：候补 2 号同刻等候递补。志愿者 B 告知：名单已满 12 人（原到场 10 + 第 7 号回归 + 候补 1），无空位。',
  ].join('\n')
  expect(findOwnerDeliveredRosterConflict(goal, [artifact(timing)])).toContain('14:06 已被计入满员名单')
  expect(findOwnerDeliveredRosterConflict(goal, [artifact(timing.replace('14:06', '14:07'))])).toBeNull()
  expect(findOwnerDeliveredRosterConflict(goal, [artifact(timing.replace('名单已满', '预留一席，未确认'))])).toBeNull()
  expect(findOwnerDeliveredRosterConflict(goal, [artifact(timing.replace('第 7 号回归 + 候补 1', '第 7 号回归；候补 1 不计入，等待离席'))])).toBeNull()
})

test('Given正文已开始确认并预留席位 When人数表在同一动作后写零 Then指出预留状态不一致', () => {
  const timing = [
    '## 迟到者与候补同时到场的示例',
    '2. 14:05：联系候补 1 并开始确认计时；候补 1 处于确认中，席位暂计为候补预留。',
    '| 时点 | 已确认 | 候补预留 | 说明 |',
    '| --- | --- | --- | --- |',
    '| 14:05 | 10 | 0 | 递补窗口开启，开始联系候补 1 |',
  ].join('\n')
  expect(findOwnerDeliveredRosterConflict(goal, [artifact(timing)])).toContain('写候补预留 0 席')
  expect(findOwnerDeliveredRosterConflict(goal, [artifact(timing.replace('10 | 0', '10 | 1'))])).toBeNull()
  expect(findOwnerDeliveredRosterConflict(goal, [artifact(timing.replace('递补窗口开启，开始联系', '窗口开启时、开始联系之前，尚未联系'))])).toBeNull()
  const twoEvents = timing.replace('递补窗口开启，开始联系候补 1 |', '开始联系候补 1，尚未接通 |\n| 14:05 | 10 | 1 | 接通，开始确认 |')
  expect(findOwnerDeliveredRosterConflict(goal, [artifact(twoEvents)])).toBeNull()
})
