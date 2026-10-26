import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { getOwnerPlanEditor, ownerPlanEditorsAtom, type OwnerPlanEditor } from '../../atoms/project-owner-plan-atoms'
import { ProjectOwnerPlanPanel } from './ProjectOwnerPlanPanel'
function render(patch: Partial<OwnerPlanEditor> = {}) {
  const store = createStore()
  store.set(ownerPlanEditorsAtom, new Map([['["a",null]', { ...getOwnerPlanEditor(new Map(), { projectId: 'a' }), loaded: true, ...patch }]]))
  return renderToStaticMarkup(createElement(Provider, { store }, createElement(ProjectOwnerPlanPanel, { projectId: 'a' })))
}
test('Given 无计划 When SSR Then 不读window，空态引导受控准备而没有本面板手工创建/生成入口', () => {
  const html = render(); expect(html).toContain('尚无可审阅计划'); expect(html).not.toContain('保存计划新版本'); expect(html).not.toContain('生成计划'); expect(html).toContain('不会调用模型')
})
test('Given 计划API失败 When 展示 Then 局部提示，不影响目标保存', () => {
  const html = render({ loaded: false, error: '计划接口不可用' }); expect(html).toContain('计划接口不可用'); expect(html).toContain('role="alert"'); expect(html).toContain('重新加载计划')
})
test('Given 已有 stale 人工计划 When SSR Then 角色建议/版本/旧确认边界清晰', () => {
  const snapshot: NonNullable<OwnerPlanEditor['snapshot']> = { projectId: 'a', schemaVersion: 1, revision: 2, planVersion: 2, goalRevision: 1, goalVersion: 1, state: 'stale', actor: 'local-user', origin: 'manual', savedAt: 1, changeReason: '历史依据', contextFingerprint: 'c', planFingerprint: 'p', sources: { project: { id: 'a', title: '项目', description: '' }, roles: [{ key: 'research', name: '研究', version: '1', sourceSha256: '', rulesSha256: '' }] }, proposal: { projectId: 'a', goalVersion: 1, mode: 'proposal_only', summary: '摘要', assumptions: ['假设'], risks: ['风险'], steps: [{ key: 's1', title: '步骤', outcome: '报告', acceptanceCriteria: ['验收标准'], dependencies: [], roleKey: 'research' }] } }
  const html = render({ snapshot, summary: '摘要', steps: snapshot.proposal.steps, assumptions: ['假设'], risks: ['风险'], requiresReview: true })
  for (const text of ['人工记录', '已过期', '报告', '验收标准', '研究', '不是员工实例', '不会收费或派工', '计划 v2', '已比较最新计划', '历史依据']) expect(html).toContain(text)
  expect(html).not.toContain('AI 已生成')
})
