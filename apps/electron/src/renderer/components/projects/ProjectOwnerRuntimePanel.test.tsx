import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { AgentWorkspace, OwnerRuntimeBinding, ProjectOwnerGoalDraft, ProjectOwnerPlanningContext, ProjectOwnerRunView } from '@gravitas/shared'
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
  link: { schemaVersion: 1, id: 'link', projectId: 'p', requestId: 'request', planningTaskId: 'planning-task', bindingRevision: 1, goalRevision: 2, goalVersion: 2, planRevision: 0, contextFingerprint: 'context', carrierFingerprint: 'carrier-hash', protocolVersion: '2', promptHash: 'prompt', purpose: 'owner_planning', maxRequests: 1, maxOutputTokens: 8192, createdAt: 1 },
  executions: [{ id: 'execution', sessionId: 'session', status: 'completed', summary: '需要补充目标用户。' }], receipts: [],
  outcomes: [{ executionId: 'execution', receiptId: 'receipt', state: 'needs_clarification', detail: '目标用户会改变方案方向。', clarification: { projectId: 'p', goalVersion: 2, contextFingerprint: 'context', reason: '需要确定受众。', questions: [{ key: 'audience', reasonType: 'source_conflict', question: '主要面向谁？', why: '这会改变产品定位。', options: ['新用户', '现有用户'], recommended: '新用户', sourceReferences: [{ sourceId: 'goal.constraints[0]', quote: '优先服务个人消费者' }, { sourceId: 'project.description', quote: '面向企业采购团队' }] }] } }],
}
function render(runtimePatch: Partial<ReturnType<typeof getOwnerRuntimeEditor>> = {}): string {
  const store = createStore()
  store.set(ownerGoalEditorsAtom, new Map([[key, { ...getOwnerGoalEditor(new Map(), subject), loaded: true, snapshot: goal, objective: goal.goal.objective, constraintsText: goal.goal.constraints.join('\n'), criteriaText: '', dirty: false }]]))
  store.set(ownerPlanEditorsAtom, new Map([[key, { ...getOwnerPlanEditor(new Map(), subject), loaded: true }]]))
  store.set(ownerRuntimeEditorsAtom, new Map([[key, { ...getOwnerRuntimeEditor(new Map(), subject), loaded: true, binding, context, runs: [run], ...runtimePatch }]]))
  return renderToStaticMarkup(createElement(Provider, { store }, createElement(ProjectOwnerRuntimePanel, subject)))
}

test('规划模块标题只放状态徽章，刷新操作在独立分隔行', () => {
  const html = render()
  const heading = html.indexOf('目标规划设置与运行记录')
  const status = html.indexOf('回答Owner的必要问题')
  const refresh = html.indexOf('刷新配置、Run与提案')
  expect(heading).toBeGreaterThan(-1)
  expect(status).toBeGreaterThan(heading)
  expect(refresh).toBeGreaterThan(status)
  expect(html.slice(status, refresh)).toContain('border-t pt-3')
})

test('Given 必要澄清已返回 When 渲染规划面板 Then 标题右侧显示状态，说明和可编辑答复分开展示', () => {
  const html = render()
  expect(html).toContain('目标规划设置与运行记录')
  expect(html).toContain('规划会根据已保存的目标和授权来源生成提案。')
  expect(html).not.toContain('下方“Owner 计划审阅”')
  for (const text of ['回答Owner的必要问题', 'aria-label="Owner规划状态说明"', '主要面向谁？', '来源冲突：请决定采用或如何协调以下来源', '这会改变产品定位。', '推荐：新用户', '澄清涉及的来源冲突', 'goal.constraints[0]', '优先服务个人消费者', 'project.description', '面向企业采购团队', '加入目标约束草案', '答复不会自动保存', '自动无费准备续跑', '再次确认本次费用']) expect(html).toContain(text)
  expect(html).not.toContain('Owner规划下一步')
  expect(html).toContain('textarea')
  expect(html).toContain('当前规划待处理事项与状态')
  expect(html).not.toContain('确认开始（可能收费）')
})

test('Given 项目文档归档失败 When 查看规划模块 Then 告警显示但仍保留本地规划记录', () => {
  const warning = '项目文档归档失败；规划内容仍保存在应用账本中。请检查项目工作区后刷新重试。'
  const html = render({ runs: [{ ...run, archiveWarning: warning }] })
  expect(html).toContain(warning)
  expect(html).toContain('重试归档')
  expect(html).toContain('当前规划待处理事项与状态')
})

test('Given 已启用的受控AI SDK员工和共同授权工作区 When 刷新配置 Then 候选出现在两个下拉框', () => {
  const workspace: AgentWorkspace = { id: 'workspace', name: '项目工作区', slug: 'project', createdAt: 1, updatedAt: 1 }
  const html = render({ employees: [{ id: 'carrier', name: '既有规划载体', role: '规划', description: '', runtime: 'ai-sdk', channelId: 'channel', modelId: 'model', workspaceId: workspace.id, workspaceIds: [workspace.id], executionProfile: 'controlled', permissionMode: 'safe', skills: [], enabled: true, totalTasks: 0, completedTasks: 0, failureCount: 0, createdAt: 1, updatedAt: 1 }], workspaces: [workspace], boundWorkspaceIds: [workspace.id], carrierId: 'carrier' })
  expect(html).toContain('既有规划载体 · 规划 · model')
  expect(html).toContain('<option value="workspace">项目工作区</option>')
})

test('Given 规划已生成 When 显示Owner规划记录 Then 主视图说明下一步且技术ID和原始JSON默认收起', () => {
  const detailedRun: ProjectOwnerRunView = {
    ...run,
    executions: [{ id: 'private-run-id', sessionId: 'session', status: 'completed', summary: '已生成提案' }],
    receipts: [{ id: 'private-receipt-id', executionId: 'private-run-id', capturedAt: 1, responseText: '{"kind":"plan_proposal"}', responseHash: 'private-hash', validTerminal: true, stopped: false, error: null, usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: null, cacheWriteTokens: null }, cost: { source: 'unknown', usd: null } }],
    outcomes: [{ executionId: 'private-run-id', receiptId: 'private-receipt-id', state: 'proposed', detail: 'AI提案待人工内容确认，不是执行许可' }],
  }
  const html = render({ runs: [detailedRun] })
  const mainView = html.split('>技术记录（高级）<')[0] ?? html
  expect(mainView).toContain('已生成待审提案')
  expect(mainView).toContain('aria-label="Owner规划状态说明"')
  expect(mainView).not.toContain('规划已完成')
  expect(mainView).toContain('请到下方“Owner 计划审阅”查看计划步骤')
  expect(mainView).not.toContain('private-run-id')
  expect(mainView).not.toContain('private-receipt-id')
  expect(mainView).not.toContain('private-hash')
  expect(html).toContain('费用暂未核实，请以服务商账单为准。')
  expect(html).toContain('查看模型原始 JSON/文本')
  expect(html).toContain('查看规划运行记录')
  expect(html).not.toContain('当前规划待处理事项与状态')
  expect(html).toContain('{&quot;kind&quot;:&quot;plan_proposal&quot;}')
})
