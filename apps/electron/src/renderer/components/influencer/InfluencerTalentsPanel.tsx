/**
 * InfluencerTalentsPanel — 达人库
 *
 * 达人的 KOL/influencer 库管理：列表 + 新增 + 状态。数据来自 InfluencerStore。
 */
import * as React from 'react'
import { Users, Plus, Loader2, Trash2 } from 'lucide-react'

interface Talent {
  id: string
  name: string
  platform: string
  handle?: string
  region?: string
  tags?: string[]
  status: 'active' | 'paused' | 'blacklist'
}

export function InfluencerTalentsPanel(): React.ReactElement {
  const [talents, setTalents] = React.useState<Talent[]>([])
  const [loading, setLoading] = React.useState(true)
  const [showAdd, setShowAdd] = React.useState(false)
  const [name, setName] = React.useState('')
  const [platform, setPlatform] = React.useState('xiaohongshu')
  const [region, setRegion] = React.useState('')
  const [handle, setHandle] = React.useState('')

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const list = (await window.electronAPI.paa.marketing.influencer.listTalents()) as Talent[]
      setTalents(list ?? [])
    } finally {
      setLoading(false)
    }
  }

  React.useEffect(() => {
    void load()
  }, [])

  const addTalent = async (): Promise<void> => {
    if (!name.trim()) return
    await window.electronAPI.paa.marketing.influencer.createTalent({
      name: name.trim(),
      platform,
      handle: handle.trim() || undefined,
      region: region.trim() || undefined,
      status: 'active',
    })
    setName('')
    setHandle('')
    setRegion('')
    setShowAdd(false)
    void load()
  }

  const removeTalent = async (id: string): Promise<void> => {
    await window.electronAPI.paa.marketing.influencer.deleteTalent(id)
    void load()
  }

  if (loading && talents.length === 0) {
    return <div className="flex items-center gap-2 p-4 text-[13px] text-foreground/50"><Loader2 size={13} className="animate-spin" />加载达人库…</div>
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-medium text-foreground/85 flex items-center gap-2">
          <Users size={14} className="text-foreground/45" />
          达人库（{talents.length}）
        </div>
        {!showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium"
          >
            <Plus size={13} />新增达人
          </button>
        )}
      </div>

      {showAdd && (
        <div className="rounded-lg border border-border/50 p-3 grid grid-cols-2 gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="达人名 *" className="col-span-2 px-2.5 py-1.5 rounded-lg border border-border/50 bg-background text-[13px] focus:outline-none" />
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="px-2 py-1.5 rounded-lg border border-border/50 bg-background text-[13px]">
            <option value="xiaohongshu">小红书</option>
            <option value="douyin">抖音</option>
            <option value="bilibili">B站</option>
            <option value="tiktok">TikTok</option>
            <option value="weibo">微博</option>
          </select>
          <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="区域" className="px-2.5 py-1.5 rounded-lg border border-border/50 bg-background text-[13px] focus:outline-none" />
          <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="账号 handle" className="col-span-2 px-2.5 py-1.5 rounded-lg border border-border/50 bg-background text-[13px] focus:outline-none" />
          <div className="col-span-2 flex gap-2">
            <button onClick={() => void addTalent()} className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[13px]">保存</button>
            <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 rounded-lg text-[13px] text-foreground/55">取消</button>
          </div>
        </div>
      )}

      {talents.length === 0 ? (
        <div className="rounded-lg border border-border/30 p-4 text-center text-[13px] text-foreground/40">暂无达人，点击「新增达人」开始</div>
      ) : (
        <div className="grid gap-2">
          {talents.map((t) => (
            <div key={t.id} className="flex items-center gap-3 rounded-lg border border-border/50 p-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground/85 text-[13px]">{t.name}</span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-foreground/[0.05] text-foreground/50">{t.platform}</span>
                  <span className={`text-[11px] px-1.5 py-0.5 rounded ${t.status === 'active' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-amber-500/15 text-amber-600'}`}>
                    {t.status === 'active' ? '活跃' : t.status}
                  </span>
                </div>
                {(t.region || t.handle) && <div className="text-[12px] text-foreground/45 mt-0.5">{[t.region, t.handle].filter(Boolean).join(' · ')}</div>}
                {t.tags && t.tags.length > 0 && <div className="text-[11px] text-foreground/40 mt-0.5">{t.tags.join(' / ')}</div>}
              </div>
              <button onClick={() => void removeTalent(t.id)} className="p-1.5 rounded-lg hover:bg-foreground/[0.05] text-foreground/35 hover:text-red-500">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default InfluencerTalentsPanel
