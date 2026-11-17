import type { OwnerTerminalEvidence } from '@gravitas/shared'

const reasonLabels: Record<OwnerTerminalEvidence['reason'], string> = {
  completed: '已正常完成',
  provider_stop: '服务商提前结束响应',
  output_limit: '达到模型输出上限',
  tool_call_incomplete: '工具调用未完成',
  runtime_error: '运行时异常',
  stopped_by_user: '你请求了停止',
  no_output: '没有返回任何输出',
  unknown: '原因未知（保留原记录）',
}

const MAX_LISTED_FILES = 10

/** Owner命令终态证据只读展示：本地回执，不等于账单确认，也不构成执行许可。 */
export function OwnerExecutionTerminalEvidence({ evidence }: { evidence: OwnerTerminalEvidence }): React.ReactElement {
  const usd = evidence.cost.actualCostMicros === null
    ? '未知（保留占额）'
    : `已结算 ${(evidence.cost.actualCostMicros / 1_000_000).toFixed(4)} 美元`
  const list = (files: readonly string[]): string => files.length === 0
    ? '无'
    : files.length <= MAX_LISTED_FILES ? files.join('、') : `${files.slice(0, MAX_LISTED_FILES).join('、')} 等 ${files.length} 个`
  return <details className="rounded-lg bg-muted/40 p-3 text-xs" aria-label="执行终止证据">
    <summary className="cursor-pointer font-medium">执行终止证据（只读）</summary>
    <dl className="mt-2 grid gap-1 sm:grid-cols-2">
      <div><dt className="text-muted-foreground">归一化原因</dt><dd>{reasonLabels[evidence.reason]}</dd></div>
      <div><dt className="text-muted-foreground">服务商终态</dt><dd>{evidence.provider ? `${evidence.provider.subtype ?? '—'} / ${evidence.provider.finishReason ?? '—'}` : '未收到终态回执'}</dd></div>
      <div><dt className="text-muted-foreground">服务商请求编号</dt><dd className="break-all">{evidence.provider?.requestId ?? '本地没有保存'}</dd></div>
      <div><dt className="text-muted-foreground">工具调用</dt><dd>{evidence.tools.calls} 次调用 / {evidence.tools.results} 次结果{evidence.tools.incompleteBatch ? '（有未完成调用）' : ''}{evidence.tools.lastToolName ? ` · 最后一次：${evidence.tools.lastToolName}` : ''}</dd></div>
      <div><dt className="text-muted-foreground">费用</dt><dd>{usd} · 请求 {evidence.cost.requestCount} 次</dd></div>
      <div className="sm:col-span-2"><dt className="text-muted-foreground">说明</dt><dd>{evidence.detail}</dd></div>
    </dl>
    {evidence.development && <div className="mt-2 space-y-1">
      <p className="text-muted-foreground">工作树：<span className="break-all">{evidence.development.worktreePath ?? '未绑定'}</span></p>
      <p className="text-muted-foreground">基线：{evidence.development.baseCommit?.slice(0, 12) ?? '未知'}</p>
      <p>已跟踪改动：{list(evidence.development.changedFiles)}</p>
      <p>未跟踪文件：{list(evidence.development.untrackedFiles)}</p>
    </div>}
    <p className="mt-2 text-muted-foreground">这些是本地保存的核对依据，不代表已确认账单，也不是执行许可。</p>
  </details>
}
