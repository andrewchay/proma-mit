import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ControlledTaskStartPreview, ProjectOwnerGoalDraft, ProjectOwnerPlanningContext } from '@gravitas/shared'
import { ControlledTaskStartButton, OwnerPlanningPreflightSummary } from './ControlledTaskStartButton'

const goal: ProjectOwnerGoalDraft = {
  schemaVersion: 1,
  revision: 1,
  state: 'draft',
  actor: 'local-user',
  savedAt: 1,
  goal: { projectId: 'project-1', goalVersion: 1, objective: '形成用户研究规划', constraints: ['不派工'], acceptanceCriteria: [] },
}
const context: ProjectOwnerPlanningContext = {
  goal,
  sources: { project: { id: 'project-1', title: '研究项目', description: '' }, roles: [] },
  fingerprint: 'context-fingerprint',
}
const ownerPlanning: NonNullable<ControlledTaskStartPreview['ownerPlanning']> = {
  purpose: 'owner_planning',
  linkId: 'link-1',
  ownerName: '项目Owner',
  bindingRevision: 1,
  goalRevision: 1,
  planRevision: 0,
  contextFingerprint: 'context-fingerprint',
  promptHash: 'prompt-fingerprint',
  protocolVersion: '1',
  maxRequests: 1,
  maxOutputTokens: 4096,
  systemPrompt: '冻结的系统指令',
  userPrompt: '冻结的用户资料',
  context,
  managementSupported: false,
  costs: 'unknown_no_hard_cap',
}

test('Given 待启动任务 When 首次渲染 Then 仅出现预检入口而不自动确认或调用模型', () => {
  let changed = 0
  const html = renderToStaticMarkup(
    <ControlledTaskStartButton taskId="fixture-task" revision={1} onChanged={() => { changed++ }} />,
  )
  expect(html).toContain('预检并开始')
  expect(html).not.toContain('确认开始（可能收费）')
  expect(html).toContain('controlled-task-start')
  expect(changed).toBe(0)
})
test('Given v4冻结规划 When费用预检展示 Then明确JSON格式不代表内容已通过', () => {
  const html = renderToStaticMarkup(<OwnerPlanningPreflightSummary ownerPlanning={{ ...ownerPlanning, protocolVersion: '4', maxOutputTokens: 8192 }} />)
  expect(html).toContain('JSON 格式输出，内容仍需校验')
  expect(html).toContain('不会自动重试')
  expect(renderToStaticMarkup(<OwnerPlanningPreflightSummary ownerPlanning={ownerPlanning} />)).not.toContain('JSON 格式输出')
})

test('Given Owner规划确认预检 When 查看默认摘要 Then 只展示目标范围和费用风险，技术细节与完整Prompt折叠', () => {
  const html = renderToStaticMarkup(React.createElement(OwnerPlanningPreflightSummary, { ownerPlanning }))
  for (const text of [
    '这次只为整理项目方案',
    '形成用户研究规划',
    '你提供的约束：不派工',
    '最多发送 1 次请求',
    '这次请求可能收费，目前无法提供硬性金额上限',
    'Owner无法在应用预算内继续自动安排员工和跟进',
    '请求状态或费用未知时会暂停核对，不会自动重试',
    '查看模型和发送资料细节',
    '查看完整发送资料和固定指令',
    '输出上限 4096 token',
    '冻结的系统指令',
  ]) expect(html).toContain(text)
  expect(html).not.toContain('实际规划载体')
  expect(html).not.toContain('safe权限本身不是沙箱')
  expect(html).not.toMatch(/<details[^>]*\sopen(?:="")?[^>]*>/)
})

test('Given 模型已有审核价格证据 When 展示规划预检 Then 不显示无法自动推进提示', () => {
  const html = renderToStaticMarkup(<OwnerPlanningPreflightSummary ownerPlanning={{ ...ownerPlanning, managementSupported: true }} />)
  expect(html).not.toContain('Owner无法在应用预算内继续自动安排员工和跟进')
})
