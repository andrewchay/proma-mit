import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { OwnerRuntimeBinding, ProjectOwnerGoalDraft, ProjectOwnerPlanningContext, ProjectOwnerRunView } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from '../../atoms/project-owner-goal-atoms'
import { getOwnerPlanEditor, ownerPlanEditorsAtom } from '../../atoms/project-owner-plan-atoms'
import { getOwnerRuntimeEditor, ownerRuntimeEditorsAtom } from '../../atoms/project-owner-runtime-atoms'
import { ProjectOwnerRuntimePanel } from './ProjectOwnerRuntimePanel'

const subject = { projectId: 'p' }
const key = '["p",null]'
const goal: ProjectOwnerGoalDraft = { schemaVersion: 1, revision: 2, state: 'draft', actor: 'local-user', savedAt: 1, goal: { projectId: 'p', goalVersion: 2, objective: '形成定位方案', constraints: ['只用授权资料'], acceptanceCriteria: [] } }
const binding: OwnerRuntimeBinding = { schemaVersion: 1, projectId: 'p', revision: 1, ownerRole: 'project_owner', ownerName: '项目Owner', carrierId: 'carrier', workspaceId: 'workspace', channelId: 'channel', modelId: 'model', runtime: 'ai-sdk', carrierFingerprint: 'binding-hash', actor: 'local-user', savedAt: 1, changeReason: '首次绑定' }
const context: ProjectOwnerPlanningContext = { goal, sources: { project: { id: 'p', title: '项目', description: '' }, roles: [] }, fingerprint: 'context' }
const run: ProjectOwnerRunView = {
  link: { schemaVersion: 1, id: 'link', projectId: 'p', requestId: 'request', planningTaskId: 'planning-task', bindingRevision: 1, goalRevision: 2, goalVersion: 2, planRevision: 0, contextFingerprint: 'context', carrierFingerprint: 'carrier-hash', protocolVersion: '1', promptHash: 'prompt', purpose: 'owner_planning', maxRequests: 1, maxOutputTokens: 4096, createdAt: 1 },
  executions: [{ id: 'execution', sessionId: 'session', status: 'completed', summary: '需要补充目标用户。' }], receipts: [],
  outcomes: [{ executionId: 'execution', receiptId: 'receipt', state: 'needs_clarification', detail: '目标用户会改变方案方向。', clarification: { reason: '需要确定受众。', questions: [{ key: 'audience', question: '主要面向谁？', why: '这会改变产品定位。', options: ['新用户', '现有用户'], recommended: '新用户' }] } }],
}
function render(): string {
  const store = createStore()
  store.set(ownerGoalEditorsAtom, new Map([[key, { ...getOwnerGoalEditor(new Map(), subject), loaded: true, snapshot: goal, objective: goal.goal.objective, constraintsText: goal.goal.constraints.join('\n'), criteriaText: '', dirty: false }]]))
  store.set(ownerPlanEditorsAtom, new Map([[key, { ...getOwnerPlanEditor(new Map(), subject), loaded: true }]]))
  store.set(ownerRuntimeEditorsAtom, new Map([[key, { ...getOwnerRuntimeEditor(new Map(), subject), loaded: true, binding, context, runs: [run] }]]))
  return renderToStaticMarkup(createElement(Provider, { store }, createElement(ProjectOwnerRuntimePanel, subject)))
}

test('Given 必要澄清已返回 When 渲染规划面板 Then 显示下一步、原因、建议和可编辑答复但不自动提交', () => {
  const html = render()
  for (const text of ['Owner规划下一步', '回答Owner的必要问题', '主要面向谁？', '这会改变产品定位。', '推荐：新用户', '加入目标约束草案', '不会自动保存或再次调用']) expect(html).toContain(text)
  expect(html).toContain('textarea')
  expect(html).not.toContain('确认开始（可能收费）')
})
