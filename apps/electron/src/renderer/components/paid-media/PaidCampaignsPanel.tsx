/**
 * PaidCampaignsPanel — 投放计划
 *
 * 广告投放 Campaign 管理：列表 + 新增 + 命名规范校验 + 目标 ROI + 状态。
 * 首期不含真实媒体 API 写钱（只读 + 建议 + 审批）。
 * 命名规范对齐投放文档：游戏-地区-平台-类型-产品-日期-时间-AIUser（须含 AIUser 后缀）。
 */
import * as React from 'react'
import { Megaphone, Plus, Loader2, Trash2, CheckCircle2 } from 'lucide-react'

interface Campaign {
  id: string
  name: string
  channel?: string
  region?: string
  platform?: string
  adType?: string
  deliverTarget?: string
  budgetDay?: number
  budgetStatus: 'pending' | 'approved' | 'rejected'
  status: 'draft' | 'active' | 'paused' | 'archived'
  goalRoi?: number
}

const STATUS_META: Record<Campaign['status'], { label: string; cls: string }> = {
  draft: { label: '草稿', cls: 'bg-foreground/[0.06] text-foreground/60' },
  active: { label: '投放中', cls: 'bg-emerald-500/15 text-emerald-600' },
  paused: { label: '已暂停', cls: 'bg-amber-500/15 text-amber-600' },
  archived: { label: '已归档', cls: 'bg-foreground/[0.05] text-foreground/45' },
}

/** 命名规范校验：须含 AIUser 后缀 */
function validateName(name: string): { ok: boolean; msg?: string } {
  if (!name.trim()) return { ok: false, msg: '名称不能为空' }
  if (!name.includes('AIUser')) return { ok: false, msg: '命名须含 AIUser 后缀（红线约束）' }
  return { ok: true }
}

export function PaidCampaignsPanel(): React.ReactElement {
  const [campaigns, setCampaigns] = React.useState<Campaign[]>([])
  const [loading, setLoading] = React.useState(true)
  const [showAdd, setShowAdd] = React.useState(false)
  const [name, setName] = React.useState('')
  const [channel, setChannel] = React.useState('google')
  const [region, setRegion] = React.useState('JP')
  const [platform, setPlatform] = React.useState('aos')
  const [deliverTarget, setDeliverTarget] = React.useState('uac3.0')
  const [budgetDay, setBudgetDay] = React.useState<number | ''>('')
  const [goalRoi, setGoalRoi] = React.useState<number | ''>('')
  const [nameError, setNameError] = React.useState('')

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const list = (await window.electronAPI.paa.marketing.paidMedia.listCampaigns()) as Campaign[]
      setCampaigns(list ?? [])
    } finally {
      setLoading(false)
    }
  }

  React.useEffect(() => {
    void load()
  }, [])

  const addCampaign = async (): Promise<void> => {
    const check = validateName(name)
    if (!check.ok) {
      setNameError(check.msg ?? '')
      return
    }
    await window.electronAPI.paa.marketing.paidMedia.createCampaign({
      name: name.trim(),
      channel,
      region,
      platform,
      deliverTarget,
      budgetDay: budgetDay === '' ? undefined : Number(budgetDay),
      goalRoi: goalRoi === '' ? undefined : Number(goalRoi),
      budgetStatus: 'pending',
      status: 'draft',
    })
    setName('')
    setBudgetDay('')
    setGoalRoi('')
    setNameError('')
    setShowAdd(false)
    void load()
  }

  const removeCampaign = async (id: string): Promise<void> => {
    await window.electronAPI.paa.marketing.paidMedia.deleteCampaign(id)
    void load()
  }

  const activeCount = campaigns.filter((c) => c.status === 'active').length
  const draftCount = campaigns.filter((c) => c.status === 'draft').length
  const pausedCount = campaigns.filter((c) => c.status === 'paused').length

  if (loading && campaigns.length === 0) {
    return <div className="flex items-center gap-2 p-4 text-[13px] text-foreground/50"><Loader2 size={13} className="animate-spin" />加载投放计划…</div>
  }

  return (
    <div className="space-y-3">
      {/* 数据看板摘要（首期基于 campaign 自身字段，metrics 后接） */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: '全部计划', value: campaigns.length },
          { label: '投放中', value: activeCount },
          { label: '草稿/暂停', value: draftCount + pausedCount },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-border/50 p-3 text-center">
            <div className="text-lg font-semibold text-foreground/85">{s.value}</div>
            <div className="text-[11px] text-foreground/45">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <div className="text-[13px] font-medium text-foreground/85 flex items-center gap-2">
          <Megaphone size={14} className="text-foreground/45" />
          投放计划（{campaigns.length}）
        </div>
        {!showAdd && (
          <button onClick={() => setShowAdd(true)} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium">
            <Plus size={13} />新建计划
          </button>
        )}
      </div>

      {showAdd && (
        <div className="rounded-lg border border-border/50 p-3 space-y-2">
          <input value={name} onChange={(e) => { setName(e.target.value); setNameError('') }} placeholder="命名：GS-JP-AOS-1-new-uac3.0-YYYYMMDD-HHMMSS-AIUser" className="w-full px-2.5 py-1.5 rounded-lg border border-border/50 bg-background text-[13px] focus:outline-none" />
          {nameError && <div className="text-[12px] text-red-500">{nameError}</div>}
          <div className="grid grid-cols-4 gap-2">
            <select value={channel} onChange={(e) => setChannel(e.target.value)} className="px-2 py-1.5 rounded-lg border border-border/50 bg-background text-[12px]">
              {['google', 'meta', 'tiktok', 'x'].map((c) => <option key={c}>{c}</option>)}
            </select>
            <select value={region} onChange={(e) => setRegion(e.target.value)} className="px-2 py-1.5 rounded-lg border border-border/50 bg-background text-[12px]">
              {['JP', 'KR', 'CHT', 'SEA', 'EU', 'NA', 'LA'].map((r) => <option key={r}>{r}</option>)}
            </select>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="px-2 py-1.5 rounded-lg border border-border/50 bg-background text-[12px]">
              {['aos', 'ios', 'pc'].map((p) => <option key={p}>{p}</option>)}
            </select>
            <select value={deliverTarget} onChange={(e) => setDeliverTarget(e.target.value)} className="px-2 py-1.5 rounded-lg border border-border/50 bg-background text-[12px]">
              {['uac1.0', 'uac2.5', 'uac3.0', 'vo', 'aeo'].map((d) => <option key={d}>{d}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input type="number" value={budgetDay} onChange={(e) => setBudgetDay(e.target.value === '' ? '' : Number(e.target.value))} placeholder="日预算 $" className="px-2.5 py-1.5 rounded-lg border border-border/50 bg-background text-[13px] focus:outline-none" />
            <input type="number" value={goalRoi} onChange={(e) => setGoalRoi(e.target.value === '' ? '' : Number(e.target.value))} placeholder="目标 ROI (%)" className="px-2.5 py-1.5 rounded-lg border border-border/50 bg-background text-[13px] focus:outline-none" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => void addCampaign()} className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[13px]">创建</button>
            <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 rounded-lg text-[13px] text-foreground/55">取消</button>
          </div>
        </div>
      )}

      {campaigns.length === 0 ? (
        <div className="rounded-lg border border-border/30 p-4 text-center text-[13px] text-foreground/40">暂无投放计划。命名须含 AIUser 后缀（红线约束）。</div>
      ) : (
        <div className="grid gap-2">
          {campaigns.map((c) => (
            <div key={c.id} className="flex items-center gap-3 rounded-lg border border-border/50 p-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground/85 text-[13px] truncate">{c.name}</span>
                  <span className={`text-[11px] px-1.5 py-0.5 rounded ${STATUS_META[c.status].cls}`}>{STATUS_META[c.status].label}</span>
                </div>
                <div className="text-[12px] text-foreground/45 mt-0.5">
                  {[c.channel, c.region, c.platform, c.deliverTarget].filter(Boolean).join(' · ')}
                  {c.budgetDay != null && ` · 日预算 $${c.budgetDay}`}
                  {c.goalRoi != null && ` · 目标ROI ${c.goalRoi}%`}
                </div>
              </div>
              <button onClick={() => void removeCampaign(c.id)} className="p-1.5 rounded-lg hover:bg-foreground/[0.05] text-foreground/35 hover:text-red-500">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default PaidCampaignsPanel
