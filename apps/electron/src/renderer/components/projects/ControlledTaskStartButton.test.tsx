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

test('Given Owner规划确认预检 When 查看默认摘要 Then 范围和费用风险简洁明确，指纹与完整Prompt折叠', () => {
  const html = renderToStaticMarkup(React.createElement(OwnerPlanningPreflightSummary, { ownerPlanning }))
  for (const text of [
    '本次请求范围',
    '只生成规划提案或必要澄清，不会派工或执行目标业务任务',
    '最多 1 次请求',
    '输出上限 4096 token',
    '不读取历史或记忆，不使用工具、MCP、Skills',
    'safe权限本身不是沙箱',
    '当前没有硬性金额上限',
    '费用或终态未知时不按零元',
    '此确认只授权本次规划请求',
    '查看版本与技术细节',
    '查看完整冻结发送资料和固定指令',
    '资料指纹 context-fingerprint',
    '冻结的系统指令',
  ]) expect(html).toContain(text)
  expect(html).not.toMatch(/<details[^>]*\sopen(?:="")?[^>]*>/)
})
