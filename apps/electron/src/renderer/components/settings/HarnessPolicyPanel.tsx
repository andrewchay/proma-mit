/**
 * HarnessPolicyPanel - Harness 策略只读视图（P04）
 *
 * 展示策略作用域、revision、三项保证强度、各 Runtime 的 required 缺口与
 * 配置损坏时的拒绝原因。只读：策略文件由运维手工维护，UI 不提供编辑。
 */

import * as React from 'react'
import { RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { HarnessPolicyState } from '@gravitas/shared'
import { HARNESS_GUARANTEE_LABELS, type GuaranteeStrength, type HarnessGuaranteeKey } from '@gravitas/shared'
import { Button } from '@/components/ui/button'
import { SettingsSection, SettingsCard } from './primitives'

const STRENGTH_LABELS: Record<GuaranteeStrength, string> = {
  off: '关闭',
  preferred: '尽力而为',
  required: '必需',
}

const STRENGTH_TONES: Record<GuaranteeStrength, string> = {
  off: 'text-muted-foreground',
  preferred: 'text-amber-600 dark:text-amber-400',
  required: 'text-emerald-600 dark:text-emerald-400',
}

const STATUS_LABELS: Record<HarnessPolicyState['status'], string> = {
  missing: '未配置（使用默认策略）',
  ok: '已加载',
  invalid: '配置无效，已保留原件并拒绝受控运行',
}

export function HarnessPolicyPanel(): React.JSX.Element {
  const [state, setState] = React.useState<HarnessPolicyState | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    try {
      setState(await window.electronAPI.getHarnessPolicyState())
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  React.useEffect(() => { void reload() }, [reload])

  return (
    <SettingsSection
      title="Harness 策略"
      description="版本化保证强度配置；策略只能收紧，required 保证不满足时在调用 Provider 前拒绝。"
      action={(
        <Button variant="outline" size="sm" onClick={() => void reload()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />刷新
        </Button>
      )}
    >
      <SettingsCard divided={false} className="p-4 space-y-3">
        {loadError && <p className="text-sm text-destructive">读取失败：{loadError}</p>}
        {state && (
          <>
            <div className="flex items-center gap-2 text-sm">
              {state.status === 'invalid'
                ? <ShieldAlert className="h-4 w-4 text-destructive" />
                : <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
              <span className="font-medium">{STATUS_LABELS[state.status]}</span>
              {state.policy && <span className="text-muted-foreground">revision {state.policy.revision}</span>}
            </div>
            <p className="text-xs text-muted-foreground break-all">作用域：{state.path}</p>
            {state.error && (
              <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                <p>{state.error}</p>
                {state.reasons.length > 0 && (
                  <ul className="mt-1 list-inside list-disc">
                    {state.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                )}
              </div>
            )}
            {state.policy && (
              <div className="grid grid-cols-1 gap-1.5 text-sm sm:grid-cols-3">
                {(Object.keys(HARNESS_GUARANTEE_LABELS) as HarnessGuaranteeKey[]).map((key) => (
                  <div key={key} className="rounded-md bg-muted/60 px-3 py-2">
                    <p className="text-xs text-muted-foreground">{HARNESS_GUARANTEE_LABELS[key]}</p>
                    <p className={`font-medium ${STRENGTH_TONES[state.policy!.guarantees[key]]}`}>
                      {STRENGTH_LABELS[state.policy!.guarantees[key]]}
                    </p>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-1 text-sm">
              <p className="text-xs font-medium text-muted-foreground">各 Runtime 的 required 缺口</p>
              {state.runtimeGaps.map((row) => (
                <div key={row.runtime} className="flex items-center justify-between rounded-md px-3 py-1.5 odd:bg-muted/40">
                  <span>
                    {row.runtimeLabel}
                    {row.retired && <span className="ml-1.5 text-xs text-muted-foreground">（已下线，仅历史会话可执行）</span>}
                  </span>
                  <span className={row.gaps.length === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                    {row.gaps.length === 0 ? '满足' : `缺口：${row.gaps.map((key) => HARNESS_GUARANTEE_LABELS[key]).join('、')}`}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              说明：审批确认（approval）与沙箱（sandbox）是独立层；本卡只反映 harness-policy.json 声明的保证强度。
              配置文件损坏时保留原件，需手工修复后重启生效。
            </p>
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}
