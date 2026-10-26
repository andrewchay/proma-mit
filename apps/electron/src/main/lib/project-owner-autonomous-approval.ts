import { BrowserWindow, dialog } from 'electron'
import type { OwnerExecutionGrantIssuePreview, ProjectOwnerGoalSubject } from '@gravitas/shared'
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
/** 可信确认由主进程原生 dialog 承载；Renderer 参数只用于发起请求，不能替代此确认。 */
export async function requestOwnerAutonomousGrantApproval(
  subject: ProjectOwnerGoalSubject,
  preview: OwnerExecutionGrantIssuePreview,
  dependencies: ApprovalDialogDependencies = electronDialog,
): Promise<void> {
  const parent = dependencies.getParent()
  if (!parent || parent.isDestroyed() || !parent.isVisible()) {
    throw new Error('无可见主窗口，无法显示自主调度原生确认框')
  }
  const response = await dependencies.showMessageBox(parent, {
    type: 'warning',
    title: '确认启用 Owner 自主调度',
    message: `允许 Gravitas 在项目「${subject.projectId}」的冻结任务范围内自主派发吗？`,
    detail: [
      `任务范围：${subject.taskId ?? `材料化批次 ${preview.materializationId}（revision ${preview.materializationRevision}）`}`,
      `计划来源：重验证 ${preview.revalidationId}（revision ${preview.revalidationRevision}）；材料化 ${preview.materializationId}（revision ${preview.materializationRevision}）；来源摘要 ${preview.sourceHash}`,
      `Executor：${preview.executorEmployeeId}；Reviewer：${preview.reviewerEmployeeId}`,
      `Runtime：${preview.runtime}；渠道：${preview.channelId}；模型：${preview.modelId}`,
      `预算账本上限：${preview.budget.maxCostMicros} 微美元；最大执行次数：${preview.budget.maxRuns}；最大返工：${preview.budget.maxRework}`,
      `授权期限：${new Date(preview.budget.expiresAt).toLocaleString()}`,
      '确认后，页面关闭时也会在以上授权范围内自动派发；不会自动重试或扩大任务范围。此本地预算账本不是 Provider 端的硬性费用上限，usage/停止状态不明时会暂停并保留占额。',
    ].join('\n'),
    buttons: ['取消', '启用自主调度'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (response.response !== 1) throw new Error('已取消自主调度授权；未创建授权记录')
}
