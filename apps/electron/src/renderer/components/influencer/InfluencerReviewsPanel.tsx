/**
 * InfluencerReviewsPanel — 达人稿件三态审核
 *
 * 达人稿件审核（红/黄/绿卡）。数据来自 InfluencerStore。
 * 注：完整审核由 ma-draft-review skill + 飞书机器人承载；此面板提供稿件列表与审核记录，供人工复核与状态跟踪。
 */
import * as React from 'react'
import { FileCheck2, Loader2, Plus } from 'lucide-react'

interface Draft {
  id: string
  briefId: string
  talentId: string
  source: string
  sourceRef?: string
  draftType: string
  reviewCard: 'red' | 'yellow' | 'green'
  status: 'submitted' | 'reviewing' | 'approved' | 'rejected' | 'rework'
  reviewer?: string
}

const CARD_META: Record<Draft['reviewCard'], { label: string; color: string; bg: string }> = {
  red: { label: '红卡', color: 'text-red-600', bg: 'bg-red-500/10' },
  yellow: { label: '黄卡', color: 'text-amber-600', bg: 'bg-amber-500/10' },
  green: { label: '绿卡', color: 'text-emerald-600', bg: 'bg-emerald-500/10' },
}

const STATUS_META: Record<Draft['status'], string> = {
  submitted: '待审核',
  reviewing: '审核中',
  approved: '已放行',
  rejected: '需返工',
  rework: '返工中',
}

export function InfluencerReviewsPanel(): React.ReactElement {
  const [drafts, setDrafts] = React.useState<Draft[]>([])
  const [loading, setLoading] = React.useState(true)
  const [showAdd, setShowAdd] = React.useState(false)
  const [source, setSource] = React.useState('')
  const [draftType, setDraftType] = React.useState('初稿')

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const list = (await window.electronAPI.paa.marketing.influencer.listDrafts()) as Draft[]
      setDrafts(list ?? [])
    } finally {
      setLoading(false)
    }
  }

  React.useEffect(() => {
    void load()
  }, [])

  const addDraft = async (): Promise<void> => {
    if (!source.trim()) return
    await window.electronAPI.paa.marketing.influencer.createDraft({
      briefId: 'draft-' + Date.now(),
      talentId: 'unknown',
      source: source.trim(),
      draftType,
      reviewCard: 'green',
      status: 'submitted',
    })
    setSource('')
    setShowAdd(false)
    void load()
  }

  if (loading && drafts.length === 0) {
    return <div className="flex items-center gap-2 p-4 text-[13px] text-foreground/50"><Loader2 size={13} className="animate-spin" />加载稿件…</div>
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-medium text-foreground/85 flex items-center gap-2">
          <FileCheck2 size={14} className="text-foreground/45" />
          稿件审核（{drafts.length}）
        </div>
        {!showAdd && (
          <button onClick={() => setShowAdd(true)} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium">
            <Plus size={13} />登记稿件
          </button>
        )}
      </div>

      {showAdd && (
        <div className="rounded-lg border border-border/50 p-3 space-y-2">
          <select value={draftType} onChange={(e) => setDraftType(e.target.value)} className="px-2 py-1.5 rounded-lg border border-border/50 bg-background text-[13px] w-full">
            {['初稿', '改稿', '终稿', '成片', '发布预览'].map((t) => <option key={t}>{t}</option>)}
          </select>
          <textarea value={source} onChange={(e) => setSource(e.target.value)} placeholder="稿件文案或来源（飞书文档链接 / 消息）" rows={3} className="w-full px-2.5 py-1.5 rounded-lg border border-border/50 bg-background text-[13px] focus:outline-none" />
          <div className="flex gap-2">
            <button onClick={() => void addDraft()} className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[13px]">登记</button>
            <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 rounded-lg text-[13px] text-foreground/55">取消</button>
          </div>
        </div>
      )}

      {drafts.length === 0 ? (
        <div className="rounded-lg border border-border/30 p-4 text-center text-[13px] text-foreground/40">暂无稿件。达人稿件经飞书群提交后自动进入审核流。</div>
      ) : (
        <div className="grid gap-2">
          {drafts.map((d) => {
            const card = CARD_META[d.reviewCard]
            return (
              <div key={d.id} className="flex items-center gap-3 rounded-lg border border-border/50 p-3">
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded ${card.bg} ${card.color}`}>{card.label}</span>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-[13px] text-foreground/85">{d.source}</div>
                  <div className="text-[12px] text-foreground/45">{d.draftType} · {STATUS_META[d.status]}{d.reviewer ? ` · ${d.reviewer}` : ''}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default InfluencerReviewsPanel
