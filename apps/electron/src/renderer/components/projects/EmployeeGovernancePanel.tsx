import * as React from 'react'
import { toast } from 'sonner'
import type { EmployeeCapabilityGovernancePolicyResult } from '@gravitas/shared'

interface FieldSpec {
  key: keyof EmployeeCapabilityGovernancePolicyResult
  label: string
  hint: string
  /** null 表示支持“关闭清理”。 */
  nullable?: boolean
  integer?: boolean
  step?: number
}

const FIELDS: FieldSpec[] = [
  { key: 'minSanitizedSamples', label: '最少已脱敏样本', hint: '低于该数量不生成评测建议', integer: true },
  { key: 'cooldownDays', label: '建议冷却期（天）', hint: '同一员工与范围在该期间内不重复建议', integer: true },
  { key: 'dailyRecommendationBudget', label: '每日建议上限', hint: '每自然日最多创建的建议数', integer: true },
  { key: 'maxConcurrentEvaluations', label: '并发评测上限', hint: '同一员工同时运行的评测数', integer: true },
  { key: 'maxCanaryPercent', label: 'Canary 最大比例（%）', hint: '允许分配给候选版本的最大流量', integer: true },
  { key: 'defaultMaxFailureRate', label: '默认失败率上限', hint: '0-1；超过则暂停 Canary 分流', step: 0.05 },
  { key: 'defaultMaxReworkRate', label: '默认返工率上限', hint: '0-1；超过则暂停 Canary 分流', step: 0.05 },
  { key: 'sampleRetentionDays', label: '样本保留期（天）', hint: '留空表示不自动清理；删除仍需手动确认', nullable: true, integer: true },
  { key: 'auditRetentionDays', label: '审计保留期（天）', hint: '留空表示不自动清理', nullable: true, integer: true },
]

/**
 * 治理策略配置面板。
 *
 * 所有变更都会写入审计；保留期留空表示不清理，且本面板不会自动删除数据。
 */
export function EmployeeGovernancePanel(): React.ReactElement {
  const [policy, setPolicy] = React.useState<EmployeeCapabilityGovernancePolicyResult | null>(null)
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const [scanSchedule, setScanSchedule] = React.useState<import('@gravitas/shared').EmployeeCapabilityScanScheduleResult | null>(null)

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const next = await window.electronAPI.paa.agentEmployees.getGovernancePolicy()
      setPolicy(next)
      setDrafts({})
    } catch (err) {
      setError(err instanceof Error ? err.message : '治理配置读取失败')
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const schedule = await window.electronAPI.paa.agentEmployees.getScanSchedule()
        if (!cancelled) setScanSchedule(schedule)
      } catch {
        // 调度不可用时不影响治理配置
      }
    })()
    return () => { cancelled = true }
  }, [])

  const toggleScanSchedule = async (enabled: boolean): Promise<void> => {
    try {
      const next = await window.electronAPI.paa.agentEmployees.updateScanSchedule({ enabled, intervalHours: scanSchedule?.intervalHours ?? 24 })
      setScanSchedule(next)
      toast.success(enabled ? '已启用周期扫描（仍只生成建议）' : '已关闭周期扫描')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '周期扫描设置失败')
    }
  }

  const save = async (): Promise<void> => {
    if (!policy) return
    const patch: Record<string, number | null> = {}
    for (const field of FIELDS) {
      const raw = drafts[field.key]
      if (raw === undefined) continue
      if (raw.trim() === '') {
        if (!field.nullable) { toast.error(`${field.label} 不能为空`); return }
        patch[field.key] = null
        continue
      }
      const value = Number(raw)
      if (!Number.isFinite(value)) { toast.error(`${field.label} 必须是数字`); return }
      patch[field.key] = value
    }
    if (Object.keys(patch).length === 0) { toast.message('没有需要保存的修改'); return }
    setSaving(true)
    try {
      const result = await window.electronAPI.paa.agentEmployees.updateGovernancePolicy(patch as Partial<EmployeeCapabilityGovernancePolicyResult>)
      setPolicy(result.policy)
      setDrafts({})
      toast.success(result.audits.length > 0 ? `已保存 ${result.audits.length} 项变更并写入审计` : '没有实际变化')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '治理配置保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (error) return <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
  if (!policy) return <p className="text-sm text-muted-foreground">治理配置加载中…</p>

  return (
    <div className="rounded-lg border border-border/50 bg-foreground/[0.02] p-4 space-y-3">
      <div>
        <h3 className="text-sm font-medium">能力演化治理策略</h3>
        <p className="mt-1 text-xs text-muted-foreground">所有变更会写入审计记录；保留期留空表示不自动清理数据。</p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {FIELDS.map((field) => {
          const current = policy[field.key]
          const raw = drafts[field.key] ?? (current === null ? '' : String(current))
          return (
            <label key={field.key} className="block text-xs">
              <span className="text-muted-foreground">{field.label}</span>
              <input
                className="mt-1 w-full rounded border bg-background px-2 py-1 text-sm"
                type="number"
                step={field.step ?? (field.integer ? 1 : 'any')}
                value={raw}
                placeholder={field.nullable ? '留空 = 不清理' : ''}
                onChange={(event) => setDrafts((prev) => ({ ...prev, [field.key]: event.target.value }))}
              />
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{field.hint}</span>
            </label>
          )
        })}
      </div>
      <div className="flex items-center gap-2">
        <button disabled={saving} className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" onClick={() => void save()}>{saving ? '保存中…' : '保存治理配置'}</button>
        <button disabled={saving} className="rounded px-3 py-1.5 text-sm text-muted-foreground hover:bg-foreground/5 disabled:opacity-50" onClick={() => setDrafts({})}>放弃修改</button>
      </div>
      <p className="text-[11px] text-muted-foreground">治理配置不可被能力候选修改；修改不会自动删除任何数据。</p>
      <div className="rounded border border-border/40 bg-background/60 p-2 text-xs">
        <p className="font-medium">建议周期扫描</p>
        <p className="mt-0.5 text-muted-foreground">默认关闭。启用后按间隔只运行本地只读扫描（不调用模型），仍只生成待确认建议。</p>
        <div className="mt-1 flex items-center gap-2">
          <button disabled={!scanSchedule} className={scanSchedule?.enabled ? 'rounded bg-foreground/10 px-2 py-1' : 'rounded bg-primary px-2 py-1 text-primary-foreground'} onClick={() => void toggleScanSchedule(!(scanSchedule?.enabled ?? false))}>{scanSchedule?.enabled ? '关闭周期扫描' : '启用周期扫描'}</button>
          <span className="text-muted-foreground">间隔 {scanSchedule?.intervalHours ?? 24} 小时 · 上次运行 {scanSchedule?.lastRunAt ? new Date(scanSchedule.lastRunAt).toLocaleString('zh-CN') : '从未'}</span>
        </div>
      </div>
    </div>
  )
}
