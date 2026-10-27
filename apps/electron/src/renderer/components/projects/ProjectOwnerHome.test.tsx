import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { ProjectOwnerHome } from './ProjectOwnerHome'
import { deriveOwnerHomeStatus, isLatestOwnerRunCurrent } from './project-owner-run-current'

function renderHome(): string {
  const store = createStore()
  return renderToStaticMarkup(createElement(Provider, { store }, createElement(ProjectOwnerHome, { projectId: 'project-1' })))
}

test('项目管理主页只呈现Owner对话，不展示内部模块导航', () => {
  const html = renderHome()
  expect(html).toContain('Owner 项目对话')
  expect(html).toContain('Owner对话式配置')
  expect(html).toContain('提交目标')
  expect(html).not.toContain('项目详情与高级设置')
  expect(html).not.toContain('目标、规划与执行准备分开呈现')
  expect(html).not.toContain('实际规划载体')
  expect(html).not.toContain('aria-label="项目目标草案"')
})

test('Owner首次对话只收集目标和可选约束，不展示内部编排表单', () => {
  const html = renderHome()
  expect(html).toContain('补充约束与完成标准（可选）')
  expect(html).toContain('这里修改的是项目正式目标，会影响后续方案和执行范围；保存后，当前目标与方案会更新，必要时会请你重新确认。')
  expect(html).not.toContain('Owner职责名称')
  expect(html).not.toContain('配置变更原因')
  expect(html).not.toContain('你确认实际员工、评审人、工作区与预算')
})

test('项目主页不再并列呈现目标、计划和执行准备模块', () => {
  const html = renderHome()
  expect(html).not.toContain('项目详情与高级设置')
  expect(html).not.toContain('规划提案是什么？')
  expect(html).not.toContain('Owner规划配置')
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

test('Given 已确认计划且来源仍当前、仅费用unknown When 主页投影阶段 Then 显示计划内容已确认而非上次规划需核对', () => {
  const status = deriveOwnerHomeStatus({
    goal: { snapshot: { revision: 2 }, conflict: false, requiresReview: false },
    runtime: {
      loading: false,
      binding: { revision: 1 },
      context: { fingerprint: 'context' },
      runs: [{
        link: { goalRevision: 2, planRevision: 0, bindingRevision: 1, contextFingerprint: 'context' },
        executions: [{ id: 'run', status: 'completed' }],
        outcomes: [{ executionId: 'run', state: 'proposed', receiptId: 'receipt', planRevision: 1 }],
        receipts: [{ executionId: 'run', cost: { source: 'unknown', usd: null } }],
      }],
    },
    plan: { snapshot: { revision: 2, state: 'confirmed', origin: 'generated', sourceRun: { executionId: 'run', receiptId: 'receipt', responseHash: 'hash' }, contextFingerprint: 'context', goalRevision: 2 } },
  })
  expect(status.runCurrent).toBe(true)
  expect(status.needsReconciliation).toBe(false)
  expect(status.costUnknown).toBe(true)
  expect(status.stage).toBe('计划内容已确认')
  expect(status.nextAction).toBe('检查已确认计划，再准备执行授权')
  expect(status.nextDetail).toContain('不影响计划内容审阅')
})

test('Given Run终态失败或停止 When 主页投影阶段 Then 仍要求先核对上次规划', () => {
  for (const state of ['failed', 'stopped', 'unknown'] as const) {
    const status = deriveOwnerHomeStatus({
      goal: { snapshot: { revision: 2 }, conflict: false, requiresReview: false },
      runtime: {
        loading: false,
        binding: { revision: 1 },
        context: { fingerprint: 'context' },
        runs: [{
          link: { goalRevision: 2, planRevision: 0, bindingRevision: 1, contextFingerprint: 'context' },
          executions: [{ id: 'run', status: 'completed' }],
          outcomes: [{ executionId: 'run', state, receiptId: 'receipt' }],
          receipts: [],
        }],
      },
      plan: { snapshot: { revision: 2, state: 'confirmed', origin: 'generated', sourceRun: { executionId: 'run', receiptId: 'receipt', responseHash: 'hash' }, contextFingerprint: 'context', goalRevision: 2 } },
    })
    expect(status.needsReconciliation).toBe(true)
    expect(status.stage).toBe('上次规划需核对')
    expect(status.nextAction).toBe('先核对上次规划请求')
  }
})
