import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { OwnerExecutionGrant } from '@gravitas/shared'
import { getOwnerExecutionEditor, ownerExecutionEditorsAtom } from '../../atoms/project-owner-execution-atoms'
import {
  getOwnerRevalidationEditor,
  ownerRevalidationEditorsAtom,
} from '../../atoms/project-owner-execution-revalidation-atoms'
import {
  getOwnerGrantEditor,
  ownerGrantEditorsAtom,
} from '../../atoms/project-owner-execution-grant-atoms'
import { ProjectOwnerExecutionGrantPanel } from './ProjectOwnerExecutionGrantPanel'
const subject = { projectId: 'a' }
const key = '["a",null]'
const budget = { maxCostMicros: 1000001, maxRuns: 2, maxRework: 0, expiresAt: 4070952000000, roleBudgetCaps: [{ roleKey: 'research', maxCostMicros: 400000 }] }
const grant: OwnerExecutionGrant = {
  ...subject,
  dispatchMode: 'manual',
  executionKind: 'controlled',
  policyRevision: 2,
  revalidationId: 'rev-1',
  revalidationRevision: 1,
  revalidationIntegrityHash: 'rev-hash',
  materializationId: 'batch-1',
  materializationRevision: 1,
  materializationIntegrityHash: 'mat-hash',
  sourceHash: 'src-hash',
  executorEmployeeId: 'e',
  reviewerEmployeeId: 'r',
  workspaceId: 'w',
  channelId: 'c',
  modelId: 'm',
  runtime: 'ai-sdk',
  budget,
  blockers: [],
  approvalFingerprint: 'a'.repeat(64),
  grantId: `owner-grant-${'a'.repeat(32)}`,
  state: 'active',
  issuedAt: 1,
}
const issuePreview = {
  ...grant,
  blockers: [] as string[],
} as Omit<OwnerExecutionGrant, 'grantId' | 'state' | 'issuedAt'>
function seedGrant(
  store: ReturnType<typeof createStore>,
  patch: Partial<ReturnType<typeof getOwnerGrantEditor>>,
) {
  store.set(
    ownerGrantEditorsAtom,
    new Map([[key, { ...getOwnerGrantEditor(new Map(), subject), ...patch }]]),
  )
}
function seedRevalidation(
  store: ReturnType<typeof createStore>,
  view: { revision: number; status: string; revalidation: unknown } | null,
) {
  store.set(
    ownerRevalidationEditorsAtom,
    new Map([
      [
        key,
        {
          ...getOwnerRevalidationEditor(new Map(), subject),
          loaded: true,
          view: view as never,
        },
      ],
    ]),
  )
}
function seedPreparation(store: ReturnType<typeof createStore>, policyRevision: number | null) {
  store.set(
    ownerExecutionEditorsAtom,
    new Map([
      [
        key,
        {
          ...getOwnerExecutionEditor(new Map(), subject),
          loaded: true,
          view: { policyRevision } as never,
        },
      ],
    ]),
  )
}
function render(seeds?: {
  grant?: Partial<ReturnType<typeof getOwnerGrantEditor>>
  revalidation?: { revision: number; status: string; revalidation: unknown } | null
  policyRevision?: number | null
}, conversational = false) {
  const store = createStore()
  if (seeds?.grant) seedGrant(store, seeds.grant)
  if (seeds?.revalidation !== undefined) seedRevalidation(store, seeds.revalidation)
  if (seeds?.policyRevision !== undefined) seedPreparation(store, seeds.policyRevision)
  return renderToStaticMarkup(
    createElement(
      Provider,
      { store },
      createElement(ProjectOwnerExecutionGrantPanel, { ...subject, conversational }),
    ),
  )
}
test('Given 未加载 When SSR Then 三条硬约束可见、按钮禁用且不冒充许可', () => {
  const html = render()
  for (const text of [
    '人工模式仍逐条确认费用和启动',
    '主进程原生确认框',
    '本地预算不是 Provider 端硬性费用上限',
    '重验证被阻断属预期',
    '预览发行影响面',
    'min-w-0',
    'flex-wrap',
  ])
    expect(html).toContain(text)
  expect(html).toContain('disabled=""')
  expect(html).toContain('aria-label="Owner 执行授权账本"')
  expect(html).not.toContain('已授权')
})
test('Given v2 current+无active grant When SSR Then 预览发行影响面可用、确认发行禁用', () => {
  const html = render({
    revalidation: { revision: 1, status: 'current', revalidation: { id: 'rev-1' } },
    policyRevision: 2,
  })
  const issue = html.match(/<button[^>]*>([^<]*预览发行影响面[^<]*)</)
  expect(issue).not.toBeNull()
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*预览发行影响面/)
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*确认发行/)
})
test('Given 重验证非current When SSR Then 发行预览禁用且给出条件说明', () => {
  const html = render({
    revalidation: { revision: 1, status: 'stale', revalidation: null },
    policyRevision: 2,
  })
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*预览发行影响面/)
  expect(html).toContain('仅当重验证来源为current')
})
test('Given active grant When SSR Then 账本行事实完整、发行禁用、撤权入口出现', () => {
  const html = render({ grant: { grant, loaded: true } })
  for (const text of [
    'owner-grant-',
    'active',
    'rev-1',
    'rev-hash',
    'batch-1',
    'mat-hash',
    '1000001',
    'research ≤ 400000 微美元',
    'unknown 按预留额占用',
    '不顺延',
    'a'.repeat(64),
    '预览撤权影响面',
    '新发行被阻断',
  ])
    expect(html).toContain(text)
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*预览发行影响面/)
})
test('Given Owner对话中的活动授权 When SSR Then 只显示业务进度和预算，不暴露内部调度字段', () => {
  const html = render({ grant: { grant, loaded: true } }, true)
  expect(html).toContain('Owner 已开始按确认范围推进')
  expect(html).toContain('Owner 会在本次确认的目标、资料权限和预算范围内自主组织团队')
  expect(html).toContain('项目共享预算上限：1.000001 美元')
  expect(html).not.toContain(grant.grantId)
  expect(html).not.toContain('模型')
  expect(html).not.toContain('最多 2 次运行')
  expect(html).not.toContain('最大返工')
  expect(html).not.toContain('执行人员')
  expect(html).not.toContain('workspace-1')
  expect(html).not.toContain('完整授权记录')
  expect(html).not.toContain('Owner 业务命令')
  expect(html).not.toContain('本次执行')
})
test('Given Owner对话中的有效发行预览 When继续授权 Then系统确认才是实际开始许可', () => {
  const html = render({
    grant: { preview: issuePreview },
    revalidation: { revision: 1, status: 'current', revalidation: { id: 'rev-1' } },
    policyRevision: 2,
  }, true)
  expect(html).toContain('只有在系统确认中选择开始，Owner 才会启动员工')
  expect(html).toContain('继续到系统开始确认')
  expect(html).not.toContain('确认范围并开始自主执行')
})
test('Given 发行预览在展示 When SSR Then 指纹/blockers/确认入口可核对且blockers非空时确认禁用', () => {
  const withBlockers = render({
    grant: { preview: { ...issuePreview, blockers: ['预算期限已过期'] } },
    revalidation: { revision: 1, status: 'current', revalidation: { id: 'rev-1' } },
    policyRevision: 2,
  })
  expect(withBlockers).toContain('发行影响面核对')
  expect(withBlockers).toContain('预算期限已过期')
  expect(withBlockers).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*确认发行/)
  const clean = render({
    grant: { preview: issuePreview },
    revalidation: { revision: 1, status: 'current', revalidation: { id: 'rev-1' } },
    policyRevision: 2,
  })
  expect(clean).toContain('blockers为空才可确认发行')
  // SSR下无点击上下文，确认按钮需待预览输入在途后启用；此处只验证blockers非空时禁用文案存在
  expect(clean).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*确认发行/)
})
test('Given 确认中 When SSR Then 确认按钮禁用并显示在途状态', () => {
  const html = render({
    grant: { preview: issuePreview, confirming: true },
    revalidation: { revision: 1, status: 'current', revalidation: { id: 'rev-1' } },
    policyRevision: 2,
  })
  expect(html).toContain('正在确认发行…')
})
test('Given 诊断错误 When SSR Then 错误可见且不自动重试', () => {
  const html = render({ grant: { error: '策略已更新，请重新预览' } })
  expect(html).toContain('策略已更新，请重新预览')
  expect(html).toContain('role="alert"')
})
test('Given 历史 When SSR Then 只读声明与账本行可核对、滚动区域用section', () => {
  const html = render({ grant: { history: [grant], historyLoaded: true } })
  expect(html).toContain('历史只读')
  expect(html).toContain('无复活路径')
  expect(html).toMatch(/<section[^>]*overflow-y-auto[^>]*aria-label="授权账本历史"/)
  expect(html).not.toMatch(/<div[^>]*class="[^"]*overflow-y-auto/)
})

test('Given授权需要对账或已归档 When展示 Then不能开始新发行流程', () => {
  for (const state of ['needs_reconcile', 'archived'] as const) {
    const html = render({ grant: { loaded: true, grant: { ...grant, state } }, revalidation: { revision: 1, status: 'current', revalidation: { id: 'rev-1' } }, policyRevision: 2 })
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*预览发行影响面/)
    expect(html).toContain('不能发行新授权')
  }
})

test('Given活动授权的冻结重验证视图stale When精确引用一致 Then保留人工执行任务选择且不开放新授权', () => {
  const record = { id: grant.revalidationId, integrityHash: grant.revalidationIntegrityHash, source: { tasks: [{ taskId: 'frozen-task', stepKey: 's', status: 'paused' }] } }
  const html = render({ grant: { loaded: true, grant }, revalidation: { revision: 1, status: 'stale', revalidation: record }, policyRevision: 2 })
  expect(html).toContain('frozen-task')
  expect(html).toContain('value="frozen-task"')
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*预览发行影响面/)
  const mismatched = render({ grant: { loaded: true, grant }, revalidation: { revision: 1, status: 'stale', revalidation: { ...record, integrityHash: 'different' } }, policyRevision: 2 })
  expect(mismatched).not.toContain('value="frozen-task"')
})
