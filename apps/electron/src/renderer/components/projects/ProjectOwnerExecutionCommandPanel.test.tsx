import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OwnerExecutionCommandView } from '@gravitas/shared'
import { getOwnerExecutionNextActionLabel, OwnerExecutionReviewDetails, ProjectOwnerExecutionCommandPanel } from './ProjectOwnerExecutionCommandPanel'

test('Given Owner Scheduler 的各类下一步状态 When生成UI文案 Then区分后台动作、有限返工与人工业务验收', () => {
  expect(getOwnerExecutionNextActionLabel('execute')).toBe('安排执行')
  expect(getOwnerExecutionNextActionLabel('review')).toBe('安排技术评审')
  expect(getOwnerExecutionNextActionLabel('rework')).toBe('授权范围内有限返工')
  expect(getOwnerExecutionNextActionLabel('await_business_acceptance')).toBe('等待人工业务验收')
  expect(getOwnerExecutionNextActionLabel('human_decision')).toBe('等待人工决策/处理')
})

test('Given用户回到Owner命令面板 When需要核对最新审批结果 Then提供显式刷新入口', () => {
  const html = renderToStaticMarkup(<ProjectOwnerExecutionCommandPanel subject={{ projectId: 'project' }} grant={null} revalidation={null} />)
  expect(html).toContain('刷新命令与审批记录')
})

test('Given执行回报与冻结标准 When展示Owner只读交付审阅 Then区分自述、技术评审和业务验收', () => {
  const command: OwnerExecutionCommandView = {
    commandId: 'command', grantId: 'grant', taskId: 'task', taskTitle: '交付审阅', employeeId: 'employee', role: 'executor', reworkOrdinal: 0,
    state: 'settled', executionId: 'execution', executionStatus: 'completed', executionResultSummary: '完成摘要 <script>alert(1)</script>',
    acceptanceCriteria: ['包含来源证据', '验证范围与目标一致'],
    actionApprovals: [{ requestId: 'request', toolName: 'Write', actionFingerprint: 'a'.repeat(64), status: 'denied', requestedAt: 1, decidedAt: 2, decidedBy: 'local-user', reason: 'user_rejected' }],
    grantAuthorization: { grantState: 'active', dispatchMode: 'manual', maxCostMicros: 1000000, maxRuns: 3, maxRework: 1, expiresAt: 9999999999999, roleBudgetCaps: [{ roleKey: 'executor', maxCostMicros: 500000 }] }, reservedCostMicros: 10, actualCostMicros: 1, ackFingerprint: 'fingerprint', createdAt: 1, updatedAt: 2,
  }
  command.textDelivery = { state: 'available', detail: '完整正文已冻结；内容仍需独立检查。', artifact: { schemaVersion: 1, projectId: 'project', grantId: command.grantId, commandId: command.commandId, executionId: command.executionId!, sessionId: 'session', taskId: command.taskId, stepLinkId: 'step', sourceHash: 'source', planRevision: 2, reworkOrdinal: 0, messageId: 'message', content: '完整成果 <script>alert(1)</script>\n正文末尾', contentSha256: 'a'.repeat(64), byteLength: 50, capturedAt: 1, integrityHash: 'b'.repeat(64) } }
  const html = renderToStaticMarkup(<OwnerExecutionReviewDetails command={command} />)
  expect(html).toContain('查看完整正文')
  expect(html).toContain('正文末尾')
  expect(html.indexOf('完整文本成果')).toBeLessThan(html.indexOf('交付审阅材料'))
  expect(html).toContain('冻结验收标准')
  expect(html).toContain('包含来源证据')
  expect(html).toContain('执行者自述')
  expect(html).toContain('Owner敏感动作审批记录')
  expect(html).toContain('已拒绝')
  expect(html).toContain('user_rejected')
  expect(html).not.toContain('secret-action-body')
  expect(html).toContain('不构成测试通过、技术评审或业务验收')
  expect(html).toContain('&lt;script&gt;')
  expect(html).not.toContain('<script>')
  const reviewerCommand: OwnerExecutionCommandView = {
    ...command,
    commandId: 'review-command',
    role: 'reviewer',
    executionResultSummary: '{"verdict":"changes_requested"}',
    technicalReview: { verdict: 'changes_requested', summary: '尚缺回归证据', criteria: [{ criterion: '包含来源证据', status: 'not_met', evidence: '没有引用来源' }], findings: [{ severity: 'medium', description: '需要补充引用', requestedChange: '关联源码来源' }], blockerReason: null },
  }
  const reviewerHtml = renderToStaticMarkup(<OwnerExecutionReviewDetails command={reviewerCommand} />)
  expect(reviewerHtml).toContain('技术评审执行回报')
  expect(reviewerHtml).toContain('结构化技术评审：changes_requested')
  expect(reviewerHtml).toContain('尚缺回归证据')
  expect(reviewerHtml).toContain('medium · 需要补充引用')
})

test('Given具体交付版本 When呈现修改意见入口 Then清楚显示其绑定命令且仅写未保存草案', () => {
  const command: OwnerExecutionCommandView = {
    commandId: 'command', grantId: 'grant', taskId: 'task', taskTitle: '交付审阅', employeeId: 'employee', role: 'executor', reworkOrdinal: 0,
    state: 'settled', executionId: 'execution', executionStatus: 'completed', acceptanceCriteria: ['冻结标准'],
    grantAuthorization: { grantState: 'active', dispatchMode: 'manual', maxCostMicros: 1000000, maxRuns: 3, maxRework: 1, expiresAt: 9999999999999, roleBudgetCaps: [{ roleKey: 'executor', maxCostMicros: 500000 }] }, reservedCostMicros: 10, actualCostMicros: 1, ackFingerprint: 'fingerprint', createdAt: 1, updatedAt: 2,
  }
  const html = renderToStaticMarkup(<OwnerExecutionReviewDetails command={command} onSubmitFeedback={async () => ({ ok: true })} />)
  expect(html).toContain('针对本交付提出修改意见')
  expect(html).toContain('命令 command')
  expect(html).toContain('加入对应Task的Goal草案')
  expect(html).toContain('只改本地未保存草案')
  expect(html).toContain('写回/外发不会因提交意见而发生')
})
