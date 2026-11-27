import { expect, test } from 'bun:test'
import { findOwnerDeliveredBudgetIssue, findOwnerItemizedBudgetIssue, readOwnerFixedBudget } from './project-owner-budget-deliverable'

const goal = { projectId: 'project', goalVersion: 1, objective: '交付 manual/handbook.md 原件。总预算不超过 240 元。写出逐项预算和合计。', constraints: [], acceptanceCriteria: [] }
const good = '| 项目 | 小计（元） |\n|---|---|\n| 材料 | 120.30 |\n| 现场用品 | 30.60 |\n| **合计** | **150.90** |'
const file = (newContent: string | null, path = 'manual/handbook.md') => ({
  fileSnapshot: true as const, content: JSON.stringify({ files: [{ file: { path }, newContent }] }),
})

test('Given原始目标要求可复算逐项预算 When最终手册只有占位和上限 Then早期通过的初稿也不能代替最终验收', () => {
  const placeholders = good.replace('120.30', '待定').replace('150.90', '不超过 240')
  expect(findOwnerDeliveredBudgetIssue(goal, [{ content: good }, file(placeholders)])).toContain('待定金额')
  expect(findOwnerDeliveredBudgetIssue(goal, [{ content: good }])).toContain('Markdown 原件')
  expect(findOwnerDeliveredBudgetIssue(goal, [{ content: file(good).content }])).toContain('Markdown 原件')
  expect(findOwnerDeliveredBudgetIssue(goal, [file(good, 'notes.md')])).toContain('Markdown 原件')
  expect(findOwnerDeliveredBudgetIssue(goal, [file(good)])).toBeNull()
})

test('Given多个步骤写同一手册 When最终版本依赖早期版本 Then按依赖选取原件并识别删除和并行分歧', () => {
  const draft = { ...file(good), stepKey: 'draft' }
  const approval = { content: '同意修改', stepKey: 'check', dependencies: ['draft'] }
  const final = { ...file(good.replace('120.30', '待定')), stepKey: 'polish', dependencies: ['check'] }
  expect(findOwnerDeliveredBudgetIssue(goal, [final, approval, draft])).toContain('待定金额')
  expect(findOwnerDeliveredBudgetIssue(goal, [draft, approval, { ...final, ...file(null) }])).toContain('Markdown 原件')
  expect(findOwnerDeliveredBudgetIssue(goal, [draft, { ...final, dependencies: [] }])).toContain('互不承接')
})

test('Given目标还有参考文件 When原件完整或只评审另一步 Then不要求重复交付参考文件或其他步骤的原件', () => {
  const withReference = { ...goal, objective: `参照 template.md。${goal.objective}` }
  expect(findOwnerDeliveredBudgetIssue(withReference, [file(good)])).toBeNull()
  expect(findOwnerDeliveredBudgetIssue(withReference, [file(good, 'appendix.md')], false)).toBeNull()
  expect(findOwnerDeliveredBudgetIssue({ ...goal, objective: '给出逐项预算和合计' }, [{ content: good }, { content: '已核对' }])).toBeNull()
  const twoOutputs = { ...goal, objective: '参照 template.md，交付 `manual/handbook.md` 和「appendix.md」，给出逐项预算和合计。' }
  expect(findOwnerDeliveredBudgetIssue(twoOutputs, [file(good)])).toContain('Markdown 原件')
  expect(findOwnerDeliveredBudgetIssue(twoOutputs, [file(good), file('附录正文。', 'appendix.md')])).toBeNull()
})

test('Given金额完整 When合计错误或超过用户上限 Then不通过最终预算核验', () => {
  expect(findOwnerItemizedBudgetIssue(goal, good.replace('150.90', '150.89'))).toContain('可复算')
  expect(findOwnerItemizedBudgetIssue(goal, good.replace('120.30', '220.30').replace('150.90', '250.90'))).toContain('超过')
  expect(findOwnerItemizedBudgetIssue({ ...goal, objective: '说明活动预算上限 240 元' }, '预算上限 240 元')).toBeNull()
})

test('Given按清单填写逐项费用 When合计可复算 Then接受无表格的手册预算', () => {
  const list = '## 预算明细\n- 材料：120 元\n- 签到用品：24.5 元\n- 合计：144.50 元'
  expect(findOwnerItemizedBudgetIssue(goal, list)).toBeNull()
})

test('Given预算明细、人数和上限全部已知 When复算 Then按每人计价并拒绝估算或未列全的价格', () => {
  const objective = '两人社区活动预算清单。场地80元，物料42元，饮用水每人4元，交通每人15元。写清各项小计及总计，对照240元上限计算余额。'
  const brief = { ...goal, objective, constraints: [], acceptanceCriteria: [] }
  expect(readOwnerFixedBudget(brief)).toEqual({ total: 16000, balance: 8000 })
  expect(readOwnerFixedBudget({ ...brief, objective: objective.replace('两人', '3人').replace('每人4元', '4.10元/人') })).toEqual({ total: 17930, balance: 6070 })
  expect(readOwnerFixedBudget({ ...brief, objective: objective.replace('物料42元', '物料待定') })).toBeNull()
  expect(readOwnerFixedBudget({ ...brief, constraints: ['另加 5 元可退押金'] })).toBeNull()
  const group = '为三人做预算。每人餐费20元、交通50元。对照150元预算上限计算余额。'
  expect(readOwnerFixedBudget({ ...brief, objective: group })).toEqual({ total: 11000, balance: 4000 })
  expect(readOwnerFixedBudget({ ...brief, objective: group.replace('每人餐费', '餐费每人每餐') })).toBeNull()
})
