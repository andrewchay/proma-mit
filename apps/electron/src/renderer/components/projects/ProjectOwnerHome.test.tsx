import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { ProjectOwnerHome } from './ProjectOwnerHome'
import { isLatestOwnerRunCurrent } from './project-owner-run-current'

function renderHome(): string {
  const store = createStore()
  return renderToStaticMarkup(createElement(Provider, { store }, createElement(ProjectOwnerHome, { projectId: 'project-1' })))
}

test('项目概览默认呈现目标对话，高级编辑器按需加载', () => {
  const html = renderHome()
  expect(html).toContain('先看目标，再决定下一步')
  expect(html).toContain('Owner对话式配置')
  expect(html).toContain('保存目标，继续')
  expect(html).toContain('项目详情与高级设置')
  expect(html).not.toContain('实际规划载体')
  expect(html).not.toContain('aria-label="项目目标草案"')
})

test('首次对话只询问目标和可选约束，不提前要求岗位或费用表单', () => {
  const html = renderHome()
  expect(html).toContain('补充约束与完成标准（可选）')
  expect(html).toContain('本地保存，不收费')
  expect(html).not.toContain('Owner职责名称')
  expect(html).not.toContain('配置变更原因')
})

test('项目主页在对话后保留高级入口且不重复挂载旧配置流程', () => {
  const html = renderHome()
  expect(html.indexOf('Owner对话式配置')).toBeLessThan(html.indexOf('项目详情与高级设置'))
  expect(html).not.toContain('Owner受控模型规划')
})

test('Given 当前Run生成的proposal使计划版本递增 When 主页判断Run来源 Then 仍标记为当前提案', () => {
  expect(isLatestOwnerRunCurrent({
    link: { goalRevision: 1, planRevision: 1, bindingRevision: 2, contextFingerprint: 'context-a' },
    executionId: 'run-current', outcome: { state: 'proposed', receiptId: 'receipt-a', planRevision: 2 },
    goalRevision: 1, bindingRevision: 2, contextFingerprint: 'context-a',
    plan: { revision: 2, state: 'proposed', origin: 'generated', sourceRun: { receiptId: 'receipt-a', executionId: 'run-current', responseHash: 'hash-a' }, contextFingerprint: 'context-a', goalRevision: 1 },
  })).toBe(true)
})

test('Given proposal后来被手工替换或来源漂移 When 主页判断Run来源 Then 不把旧Run标为当前', () => {
  const base = {
    link: { goalRevision: 1, planRevision: 1, bindingRevision: 2, contextFingerprint: 'context-a' },
    executionId: 'run-current', outcome: { state: 'proposed' as const, receiptId: 'receipt-a', planRevision: 2 },
    goalRevision: 1, bindingRevision: 2, contextFingerprint: 'context-a',
    plan: { revision: 3, state: 'proposed' as const, origin: 'manual' as const, contextFingerprint: 'context-a', goalRevision: 1 },
  }
  expect(isLatestOwnerRunCurrent(base)).toBe(false)
  expect(isLatestOwnerRunCurrent({ ...base, contextFingerprint: 'context-b' })).toBe(false)
})

test('Given 同来源暂停准备尚无execution When 主页核对来源 Then 不误报为历史来源变化', () => {
  expect(isLatestOwnerRunCurrent({ link: { goalRevision: 1, planRevision: 0, bindingRevision: 1, contextFingerprint: 'context' },
    goalRevision: 1, plan: null, bindingRevision: 1, contextFingerprint: 'context' })).toBe(true)
})

 test('Given 同一可信Run的提案已确认 When 内容确认推进revision Then 仍为当前Run，错回执或stale不能复用', () => {
  const base = {
    link: { goalRevision: 1, planRevision: 0, bindingRevision: 1, contextFingerprint: 'context' },
    executionId: 'run', outcome: { state: 'proposed' as const, receiptId: 'receipt', planRevision: 1 },
    goalRevision: 1, bindingRevision: 1, contextFingerprint: 'context',
    plan: { revision: 2, state: 'confirmed' as const, origin: 'generated' as const, sourceRun: { executionId: 'run', receiptId: 'receipt', responseHash: 'hash' }, contextFingerprint: 'context', goalRevision: 1 },
  }
  expect(isLatestOwnerRunCurrent(base)).toBe(true)
  expect(isLatestOwnerRunCurrent({ ...base, plan: { ...base.plan, state: 'stale' } })).toBe(false)
  expect(isLatestOwnerRunCurrent({ ...base, outcome: { ...base.outcome, receiptId: 'other' } })).toBe(false)
})
