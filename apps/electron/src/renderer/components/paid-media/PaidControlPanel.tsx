/**
 * PaidControlPanel — 调控审批流
 *
 * Agent 调控建议（换素材/调预算/暂停）→ 人工审批（批准/驳回）→ 执行状态。
 * 对齐投放文档「广告调控」：Agent 提出操作 → 审批卡 → 运营批准/驳回 → 执行。
 */
import * as React from 'react'
import { Gauge, Plus, Loader2, Check, X } from 'lucide-react'

interface ControlAction {
  id: string
  campaignId: string
  actionType: string
  detail?: unknown
  status: 'pending' | 'approved' | 'rejected' | 'executed'
  reviewer?: string
}

const ACTION_META: Record<string, { label: string; cls: string }> = {
  '换素材': { label: '换素材', cls: 'bg-blue-500/10 text-blue-600' },
  '换文案': { label: '换文案', cls: 'bg-blue-500/10 text-blue-600' },
  '调预算': { label: '调预算', cls: 'bg-purple-500/10 text-purple-600' },
  '暂停': { label: '暂停', cls: 'bg-red-500/10 text-red-600' },
  '新建广告组': { label: '新建广告组', cls: 'bg-emerald-500/10 text-emerald-600' },
  '补素材': { label: '补素材', cls: 'bg-teal-500/10 text-teal-600' },
}

const STATUS_META: Record<ControlAction['status'], { label: string; cls: string }> = {
  pending: { label: '待批准', cls: 'bg-amber-500/15 text-amber-600' },
  approved: { label: '已批准', cls: 'bg-emerald-500/15 text-emerald-600' },
  rejected: { label: '已驳回', cls: 'bg-red-500/15 text-red-600' },
  executed: { label: '已执行', cls: 'bg-foreground/[0.06] text-foreground/60' },
}

const DEFAULTS: Array<{ type: string; campaign: string }> = [
  { type: '换素材', campaign: 'ZZZ-JP-AOS-1-new-uac3.0-20260406-230442-AIUser' },
  { type: '调预算', campaign: 'HSR-KR-AOS-1-ret-uac2.5-20260612-110200-AIUser' },
]

export function PaidControlPanel(): React.ReactElement {
  const [actions, setActions] = React.useState<ControlAction[]>([])
  const [loading, setLoading] = React.useState(true)
  const [showAdd, setShowAdd] = React.useState(false)

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const list = (await window.electronAPI.paa.marketing.paidMedia.listControlActions()) as ControlAction[]
      setActions(list ?? [])
    } finally {
      setLoading(false)
    }
  }

  React.useEffect(() => {
    void load()
  }, [])

  const addSuggestion = async (type: string, campaign: string): Promise<void> => {
    await window.electronAPI.paa.marketing.paidMedia.createControlAction({
      campaignId: campaign,
      actionType: type,
      status: 'pending',
    })
    setShowAdd(false)
    void load()
  }

  const review = async (id: string, status: 'approved' | 'rejected'): Promise<void> => {
    await window.electronAPI.paa.marketing.paidMedia.updateControlAction(id, { status, reviewer: '运营' })
    void load()
  }

  if (loading && actions.length === 0) {
    return <div className="flex items-center gap-2 p-4 text-[13px] text-foreground/50"><Loader2 size={13} className="animate-spin" />加载调控建议…</div>
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-medium text-foreground/85 flex items-center gap-2">
          <Gauge size={14} className="text-foreground/45" />
          调控审批（{actions.length}）
        </div>
        {!showAdd && (
          <button onClick={() => setShowAdd(true)} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium">
            <Plus size={13} />提出调控建议
          </button>
        )}
      </div>

      {showAdd && (
        <div className="rounded-lg border border-border/50 p-3 space-y-2">
          {DEFAULTS.map((d) => (
            <button key={d.type + d.campaign} onClick={() => void addSuggestion(d.type, d.campaign)} className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-border/40 hover:bg-foreground/[0.03] text-left">
              <span className="text-[13px] text-foreground/80">{d.type} — {d.campaign}</span>
              <span className="text-[11px] text-foreground/40">生成建议</span>
            </button>
          ))}
          <button onClick={() => setShowAdd(false)} className="w-full px-3 py-1.5 rounded-lg text-[12px] text-foreground/55 hover:bg-foreground/[0.03]">取消</button>
        </div>
      )}

      {actions.length === 0 ? (
        <div className="rounded-lg border border-border/30 p-4 text-center text-[13px] text-foreground/40">
          无调控建议。Agent 基于调控规则提出换素材/调预算/暂停等建议，由运营审批。
        </div>
      ) : (
        <div className="grid gap-2">
          {actions.map((a) => {
            const ac = ACTION_META[a.actionType] ?? { label: a.actionType, cls: 'bg-foreground/[0.05] text-foreground/60' }
            const st = STATUS_META[a.status]
            return (
              <div key={a.id} className="flex items-center gap-3 rounded-lg border border-border/50 p-3">
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded ${ac.cls}`}>{ac.label}</span>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-[13px] text-foreground/85">{a.campaignId}</div>
                  <div className="text-[12px] text-foreground/45">
                    <span className={`px-1.5 py-0.5 rounded text-[11px] ${st.cls}`}>{st.label}</span>
                    {a.reviewer && ` · ${a.reviewer}`}
                  </div>
                </div>
                {a.status === 'pending' && (
                  <div className="flex gap-1.5">
                    <button onClick={() => void review(a.id, 'approved')} className="flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-500/15 text-emerald-600 text-[12px] hover:bg-emerald-500/25">
                      <Check size={12} />批准
                    </button>
                    <button onClick={() => void review(a.id, 'rejected')} className="flex items-center gap-1 px-2 py-1 rounded-md bg-red-500/15 text-red-600 text-[12px] hover:bg-red-500/25">
                      <X size={12} />驳回
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default PaidControlPanel
