import type { OwnerPreflightReconciliationPreview } from '@gravitas/shared'

const button = 'rounded-md bg-destructive px-3 py-2 text-sm text-destructive-foreground disabled:opacity-50'

export function ProjectOwnerPreflightReconciliationConfirm({
  preview,
  busy,
  checked,
  onCheckedChange,
  onConfirm,
}: {
  preview: OwnerPreflightReconciliationPreview
  busy: boolean
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  onConfirm: () => void
}): React.ReactElement {
  return <div className="space-y-2 rounded-md bg-card p-3 text-sm" aria-label="发送前失败对账确认">
    <p>命令 {preview.commandId} · {preview.provider} / {preview.modelId}</p>
    <p>本地拒绝原因：{preview.reasonCode}；证据类型：{preview.evidenceKind === 'typed_preflight' ? '类型化发送前拒绝' : '历史兼容记录（拒绝发生时未保存类型化事件）'}。</p>
    <p>逐请求预留记录数为 0。{preview.preReconciliationUsageMarker === 'runtime_unknown' ? '命令另有Runtime终态unknown标记（不是Provider逐请求用量）；确认后会将其哈希留在本地审计中。' : '命令没有既有Runtime unknown标记。'}原命令上限 {preview.reservedCostMicros.toLocaleString()} 微美元与 1 次运行次数将释放；旧授权会暂停，不会自动重试。拒绝错误SHA-256：{preview.errorSha256}</p>
    <p className="text-xs text-muted-foreground">这是本地失败记录与操作人声明，不是 Provider 签名账单或独立核验的零费用证明。</p>
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={checked} disabled={busy} onChange={event => onCheckedChange(event.target.checked)} />
      <span>我已核对对应渠道/模型的 Provider 控制台，确认没有这次请求或用量；我理解这会释放费用预留和一次运行次数，但不会自动重试或恢复授权。</span>
    </label>
    <button type="button" className={button} disabled={busy || !checked} onClick={onConfirm}>
      {busy ? '正在记录对账…' : '确认未发送并释放占额'}
    </button>
  </div>
}
