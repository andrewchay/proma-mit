import { findOwnerClosedWorklistConflict } from './project-owner-delivery-content'
import { expect, test } from 'bun:test'
import { findOwnerDeliveredRosterConflict, findOwnerRosterScenarioConflict, readOwnerRosterDeadlineInstruction } from './project-owner-roster-scenario'

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

test('Given具名报名场景只给候补到场时间 When正文表填写其他人的具体时刻 Then要求使用原始事实', () => {
  const brief = { ...goal, objective: '14:00开场，13:45签到，报名甲乙丙共三人，乙未到；候补丁13:58到场，确认耗时3分钟。' }
  const content = ['| 人员 | 身份 | 到场时间 |', '| -- | -- | -- |', '| 甲 | 报名 | 13:45 内 |', '| 丁 | 候补 | 13:58 |'].join('\n')
  expect(findOwnerRosterScenarioConflict(brief, content)).toContain('原目标未提供「甲」在 13:45')
  expect(findOwnerRosterScenarioConflict(brief, content.replace('13:45 内', '已到，时间未提供'))).toBeNull()
})


test('Given只做原目标的三项工作 When模板新增签字确认 Then要求删除额外动作', () => {
  const brief = { ...goal, objective: '只有三项工作：核对钥匙3把、检查两部对讲机、记录场地巡检状态。' }
  const body = ['接班人：＿＿', '## 钥匙', '## 对讲机', '## 巡检'].join('\n')
  expect(findOwnerClosedWorklistConflict(brief, body)).toBeNull()
  const withSignature = body + '\n接班人签字确认：__________'
  expect(findOwnerClosedWorklistConflict(brief, withSignature)).toContain('额外动作')
  expect(findOwnerClosedWorklistConflict({ ...brief, objective: brief.objective + '请保留签字位。' }, withSignature)).toBeNull()
  expect(findOwnerClosedWorklistConflict({ ...brief, objective: brief.objective + '不得新增签字确认。' }, withSignature)).toContain('额外动作')
})

test('Given正式补位有严格截止 When走查无误却在截止后更新正式名单 Then拒绝正文及文件交付', () => {
  const brief = { ...goal, objective: '交付 manual/handbook.md。候补丁13:58到场，确认耗时3分钟，14:00前完成才能正式补位。写清14:01后的处理。' }
  const content = [
    '确认须在 14:00 开场前完成，方可正式补位。',
    '14:00 正式名单为甲、丙两人。',
    '## 五、14:01 后处理规则',
    '1. 14:00 时未完成候补确认的，确认流程可在开场后继续完成。',
    '2. 确认完成后，丁于完成时点正式补位，名单更新为甲、丙、丁，人数 3。',
  ].join('\n')
  expect(findOwnerRosterScenarioConflict(brief, content)).toContain('14:00 前完成确认')
  expect(findOwnerDeliveredRosterConflict(brief, [artifact(content)])).toContain('丁于完成时点正式补位')
  expect(findOwnerRosterScenarioConflict(brief, content.replace(content.split('\n').at(-1)!, '2. 丁在 14:01 确认，只记录结果，不正式补位。'))).toBeNull()
  expect(findOwnerRosterScenarioConflict(brief, '丁 14:00 完成确认并正式补位。')).toContain('截止时或截止后')
  expect(findOwnerRosterScenarioConflict(brief, '| 14:01 完成确认 | 丁 | 纳入正式名单 |')).toContain('纳入正式名单')
  const earlierArrival = { ...brief, objective: brief.objective.replace('13:58', '13:56') }
  expect(findOwnerRosterScenarioConflict(earlierArrival, '丁 13:59 完成确认并正式补位。')).toBeNull()
  expect(findOwnerRosterScenarioConflict(earlierArrival, '丁 13:59 完成确认，14:01 登记并纳入正式名单。')).toBeNull()
  expect(findOwnerRosterScenarioConflict(brief, '丁 13:59 完成确认并正式补位。')).toContain('冲突原文')
  expect(findOwnerRosterScenarioConflict(brief, '| 候补 1 | 丁 | 已到 | 确认耗时 3 分钟，14:00 前完成，正式补位 |')).toContain('冲突原文')
  expect(findOwnerRosterScenarioConflict(brief, '丁14:01完成确认，不满足「14:00 前完成才能正式补位」，只记录。')).toBeNull()
  expect(readOwnerRosterDeadlineInstruction(brief)).toContain('最早于 14:01 完成')
  expect(readOwnerRosterDeadlineInstruction(earlierArrival)).toBeNull()
  expect(readOwnerRosterDeadlineInstruction({ ...brief, constraints: ['候补丁13:58到场，确认耗时3分钟。'] })).toContain('最早于 14:01 完成')
  expect(findOwnerRosterScenarioConflict(brief, '丁未完成确认，戊正式补位。')).toBeNull()
  expect(findOwnerRosterScenarioConflict(brief, '丁 13:58 到场，但戊于 13:59 完成确认并正式补位。')).toBeNull()
  expect(findOwnerRosterScenarioConflict(brief, '丁 14:01 完成候补确认，随后允许递补。')).toContain('允许递补')
  expect(findOwnerRosterScenarioConflict(brief, '## 14:01 后\n### 14:05 后\n### 更新\n确认完成的候补可正式补位。')).toContain('确认完成的候补')
  expect(findOwnerRosterScenarioConflict(brief, '## 14:01 后处理\n丁不能正式补位。\n## 其他情境\n已按时确认的人可正式补位。')).toBeNull()
  expect(findOwnerRosterScenarioConflict(brief, '~~~md\n丁 14:01 正式补位。\n~~~')).toBeNull()
  expect(findOwnerRosterScenarioConflict(goal, '丁 14:01 正式补位。')).toBeNull()
  expect(findOwnerRosterScenarioConflict({ ...brief,
    objective: '候补 9:00 前完成确认方可正式补位。', constraints: ['09:00 前完成确认才可以正式补位。'],
  }, '09:01 确认完成后正式补位。')).toContain('截止时或截止后')
})

test('Given 候补手册固定14:00开场 When 把主持人宣布开场放在14:05落座步骤 Then 拒绝偏移且允许另列换桌', () => {
  const brief = { ...goal, objective: '14:00开场，候补丁13:58到场，确认耗时3分钟，14:00前完成才能正式补位。' }
  const bad = '丁不能正式补位。\n14:05 前完成所有换桌落座，主持人宣布开场。'
  expect(findOwnerRosterScenarioConflict(brief, bad)).toContain('原目标要求 14:00 开场')
  expect(findOwnerRosterScenarioConflict(brief, '丁不能正式补位。\n14:05宣布开场。')).toContain('原目标要求 14:00 开场')
  expect(findOwnerRosterScenarioConflict(brief, '丁不能正式补位。\n**14:00** 准时开场。14:05 前完成换桌落座。')).toBeNull()
  expect(findOwnerRosterScenarioConflict(brief, '~~~md\n14:05宣布开场。\n~~~\n14:00开场。')).toBeNull()
  expect(findOwnerRosterScenarioConflict(brief, '13:55 开场提醒发到群里。14:00 准时开场。')).toBeNull()
  expect(findOwnerRosterScenarioConflict(brief, '14:00 准时开场。13:55 前完成换桌，随后主持人宣布开场。')).toBeNull()

})
