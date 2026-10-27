import { ownerExecutionModelSummary } from '@gravitas/shared'
import { BrowserWindow, dialog } from 'electron'
import type { OwnerExecutionGrantIssuePreview, ProjectOwnerGoalSubject } from '@gravitas/shared'
import type { OwnerAutonomousApprovalSummary } from './project-owner-autonomous-approval-summary'
interface ApprovalWindow {
  isDestroyed: () => boolean
  isVisible: () => boolean
}
interface NativeDialogOptions {
  type: 'warning'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: boolean
}
interface ApprovalDialogDependencies {
  getParent: () => ApprovalWindow | null
  showMessageBox: (parent: ApprovalWindow, options: NativeDialogOptions) => Promise<{ response: number }>
}
const electronDialog: ApprovalDialogDependencies = {
  getParent: () => BrowserWindow.getFocusedWindow()
    ?? BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.isVisible())
    ?? null,
  showMessageBox: (parent, options) => dialog.showMessageBox(parent as InstanceType<typeof BrowserWindow>, options),
}
const MAX_APPROVAL_LABEL_LENGTH = 300
const TRUNCATION_SUFFIX = '…（已截短）'
const label = (value: string): string => {
  const clean = value.replace(/[\r\n]/g, ' ')
  return clean.length <= MAX_APPROVAL_LABEL_LENGTH
    ? clean
    : `${clean.slice(0, MAX_APPROVAL_LABEL_LENGTH - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`
}
/** 可信确认由主进程原生 dialog 承载；Renderer 参数只用于发起请求，不能替代此确认。 */
export async function requestOwnerAutonomousGrantApproval(
  subject: ProjectOwnerGoalSubject,
  preview: OwnerExecutionGrantIssuePreview,
  dependencies: ApprovalDialogDependencies = electronDialog,
  summary?: OwnerAutonomousApprovalSummary,
): Promise<void> {
  const parent = dependencies.getParent()
  if (!parent || parent.isDestroyed() || !parent.isVisible()) {
    throw new Error('无可见主窗口，无法显示自主调度原生确认框')
  }
  const response = await dependencies.showMessageBox(parent, {
    type: 'warning',
    title: summary ? '确认开始项目执行' : '确认启用 Owner 自主调度',
    message: summary
      ? `确认让 Owner 在项目「${label(summary.projectTitle)}」中开始以下工作吗？`
      : `确认让 Owner 在项目「${label(subject.projectId)}」中开始执行吗？`,
    detail: summary ? [
      `预期成果：${summary.deliverables.map(label).join('；')}`,
      'Owner会自行组织项目现有团队和独立检查，不需要你安排执行人员、工作位置或模型。',
      ...(preview.qualityManagementVersion === 1 ? ['质量责任：Owner读取完整成果和独立评审，按标准决定子任务验收、解除依赖及授权内有限返工；不代替事先约定的人类业务决定，不含发布或外发。'] : []),
      ...(preview.qualityManagementVersion === 1 && preview.executionKind === 'development' ? ['代码成果质量依据：冻结代码快照、绑定的本地验证回执与独立技术评审；未知或不完整证据不算通过。'] : []),
      ...(preview.textDeliveryVersion === 1 ? [preview.qualityManagementVersion === 1 ? '交付方式：完整最终回复保存为本机文本成果，独立评审核对准确版本；保存或评审本身不代表达标，不含发布。' : '交付方式：完整最终回复保存为本机文本成果，独立评审核对准确版本；不代表业务验收或发布。'] : []),
      `补充资料：${summary.knowledgeNames.length ? summary.knowledgeNames.map(label).join('、') : '不额外授权知识资料'}`,
      ...(summary.allowedPaths.length ? [`允许修改：${summary.allowedPaths.map(label).join('；')}`] : []),
      `项目共享预算上限：${(preview.budget.maxCostMicros / 1000000).toLocaleString()} 美元`,
      `有效期至：${new Date(preview.budget.expiresAt).toLocaleString()}`,
      '确认后，Owner将在以上成果、资料、修改和预算边界内自主执行与验收，离开项目页面也会继续。超出范围或需要你决定时会停下沟通。',
      '本地预算台账不是 Provider 端的硬性费用上限；用量或停止状态不明时保留占额并暂停核对。',
    ].join('\n') : [
      `任务范围：${subject.taskId ?? `材料化批次 ${preview.materializationId}（revision ${preview.materializationRevision}）`}`,
      `计划来源：重验证 ${preview.revalidationId}（revision ${preview.revalidationRevision}）；材料化 ${preview.materializationId}（revision ${preview.materializationRevision}）；来源摘要 ${preview.sourceHash}`,
      `Executor：${preview.executorEmployeeId}；Reviewer：${preview.reviewerEmployeeId}`,
      `Runtime：${preview.runtime}；渠道：${preview.channelId}；模型：${label(ownerExecutionModelSummary(preview))}`,
      `预算账本上限：${preview.budget.maxCostMicros} 微美元；最大执行次数：${preview.budget.maxRuns}；最大返工：${preview.budget.maxRework}`,
      `授权期限：${new Date(preview.budget.expiresAt).toLocaleString()}`,
      '确认后，页面关闭时也会在以上授权范围内自动派发；不会自动重试或扩大任务范围。此本地预算账本不是 Provider 端的硬性费用上限，usage/停止状态不明时会暂停并保留占额。',
    ].join('\n'),
    buttons: summary ? ['取消', '确认并开始'] : ['取消', '启用自主调度'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (response.response !== 1) throw new Error('已取消自主调度授权；未创建授权记录')
}
