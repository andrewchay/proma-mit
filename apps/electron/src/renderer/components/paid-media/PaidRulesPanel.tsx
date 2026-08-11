/**
 * PaidRulesPanel — 调控规则引擎
 *
 * 三档规则（对齐投放文档「广告调控-调控规则」）：
 * - 红线(redline)：不可违反，强制加载（如命名须含 AIUser）
 * - 业务(business)：可调业务规则
 * - 软提示(hint)：软性提示
 * 可编辑参数阈值与启停。
 */
import * as React from 'react'
import { ClipboardCheck, Plus, Loader2, Power } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Rule {
  id: string
  channel?: string
  kind: 'redline' | 'business' | 'hint'
  name: string
  params?: unknown
  enabled: boolean
}

const KIND_META: Record<Rule['kind'], { label: string; icon: string; cls: string }> = {
  redline: { label: '红线', icon: '🛡', cls: 'bg-red-500/10 text-red-600' },
  business: { label: '业务规则', icon: '📚', cls: 'bg-blue-500/10 text-blue-600' },
  hint: { label: '软提示', icon: '💡', cls: 'bg-amber-500/10 text-amber-600' },
}

const RULE_TEMPLATES: Rule[] = [
  { id: '__tpl__', kind: 'redline', name: '命名须含 AIUser 后缀', channel: 'all', params: { description: 'Agent 仅监控含 AIUser 的广告' }, enabled: true },
  { id: '__tpl__', kind: 'business', name: '目标净ROI365 阈值', channel: 'google', params: { healthy: 130, risk: 100 }, enabled: true },
  { id: '__tpl__', kind: 'hint', name: '低消耗告警提示', channel: 'all', params: { minSpend: 100 }, enabled: true },
]

export function PaidRulesPanel(): React.ReactElement {
  const [rules, setRules] = React.useState<Rule[]>([])
  const [loading, setLoading] = React.useState(true)
  const [showAdd, setShowAdd] = React.useState(false)

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const list = (await window.electronAPI.paa.marketing.paidMedia.listRules()) as Rule[]
      setRules(list ?? [])
    } finally {
      setLoading(false)
    }
  }

  React.useEffect(() => {
    void load()
  }, [])

  const addRule = async (tpl: Rule): Promise<void> => {
    await window.electronAPI.paa.marketing.paidMedia.createRule({
      kind: tpl.kind,
      name: tpl.name,
      channel: tpl.channel,
      params: tpl.params,
      enabled: true,
    })
    setShowAdd(false)
    void load()
  }

  const toggleRule = async (r: Rule): Promise<void> => {
    await window.electronAPI.paa.marketing.paidMedia.updateRule(r.id, { enabled: !r.enabled })
    void load()
  }

  if (loading && rules.length === 0) {
    return <div className="flex items-center gap-2 p-4 text-[13px] text-foreground/50"><Loader2 size={13} className="animate-spin" />加载调控规则…</div>
  }

  const grouped = (['redline', 'business', 'hint'] as const).map((kind) => ({ kind, items: rules.filter((r) => r.kind === kind) }))

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-medium text-foreground/85 flex items-center gap-2">
          <ClipboardCheck size={14} className="text-foreground/45" />
          调控规则（{rules.length} · 红线强制加载）
        </div>
        {!showAdd && (
          <button onClick={() => setShowAdd(true)} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium">
            <Plus size={13} />添加规则
          </button>
        )}
      </div>

      {showAdd && (
        <div className="rounded-lg border border-border/50 p-3 space-y-2">
          <div className="text-[12px] text-foreground/50 mb-1">选择预设规则模板：</div>
          {RULE_TEMPLATES.map((t) => (
            <button key={t.name} onClick={() => void addRule(t)} className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-border/40 hover:bg-foreground/[0.03] text-left">
              <span className="flex items-center gap-2 text-[13px] text-foreground/80">
                <span>{KIND_META[t.kind].icon}</span>{t.name}
              </span>
              <span className="text-[11px] text-foreground/40">{KIND_META[t.kind].label}</span>
            </button>
          ))}
          <button onClick={() => setShowAdd(false)} className="w-full px-3 py-1.5 rounded-lg text-[12px] text-foreground/55 hover:bg-foreground/[0.03]">取消</button>
        </div>
      )}

      {rules.length === 0 ? (
        <div className="rounded-lg border border-border/30 p-4 text-center text-[13px] text-foreground/40">
          暂无调控规则。红线规则将由 goal_optimizer 与决策推理每次审议时强制加载。
        </div>
      ) : (
        <div className="space-y-3">
          {grouped.map(({ kind, items }) =>
            items.length > 0 ? (
              <div key={kind}>
                <div className="text-[12px] font-medium text-foreground/55 mb-1.5">{KIND_META[kind].icon} {KIND_META[kind].label}</div>
                <div className="space-y-1.5">
                  {items.map((r) => (
                    <div key={r.id} className="flex items-center gap-3 rounded-lg border border-border/50 p-2.5">
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] text-foreground/85">{r.name}</div>
                        <div className="text-[11px] text-foreground/45">
                          {r.channel ? `渠道: ${r.channel}` : ''}
                          {r.params ? <span className="ml-2 font-mono">{String(JSON.stringify(r.params))}</span> : null}
                        </div>
                      </div>
                      <button
                        onClick={() => void toggleRule(r)}
                        className={cn(
                          'flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] border',
                          r.enabled ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' : 'bg-foreground/[0.04] text-foreground/40 border-border/30'
                        )}
                      >
                        <Power size={12} />{r.enabled ? '启用' : '停用'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null
          )}
        </div>
      )}
    </div>
  )
}

export default PaidRulesPanel
