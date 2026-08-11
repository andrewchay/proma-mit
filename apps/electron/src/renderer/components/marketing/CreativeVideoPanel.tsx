/**
 * CreativeVideoPanel — 共享素材 · 视频生成面板
 *
 * 供达人 influencer 与 广告投放 paid-media 两包复用（共享素材能力层）。
 * 能力通过 window.electronAPI.paa.marketing.creative 调用主进程：
 *   - 分镜生成（纯本地）：输入产品/卖点 → generateStoryboard
 *   - 引擎凭据检查：checkCredential
 *   - 完整流水线：runPipeline（预留，需配视频引擎凭据）
 */
import * as React from 'react'
import { Clapperboard, Loader2, Check, AlertTriangle, ChevronDown } from 'lucide-react'

interface StoryboardShotView {
  shotId: string
  duration: number
  scene: string
  visualDescription: string
  narration: string
}

export function CreativeVideoPanel(): React.ReactElement {
  const [product, setProduct] = React.useState('')
  const [category, setCategory] = React.useState('')
  const [sellingPoints, setSellingPoints] = React.useState('')
  const [platform, setPlatform] = React.useState<'xiaohongshu' | 'douyin' | 'bilibili' | 'weibo'>('douyin')
  const [duration, setDuration] = React.useState(15)
  const [engine, setEngine] = React.useState<'seedance' | 'minimax-h3'>('seedance')
  const [credOk, setCredOk] = React.useState<boolean | null>(null)
  const [credMsg, setCredMsg] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [storyboard, setStoryboard] = React.useState<StoryboardShotView[] | null>(null)
  const [error, setError] = React.useState('')

  const checkCredential = async (): Promise<void> => {
    const res = (await window.electronAPI.paa.marketing.creative.checkCredential(engine)) as { ok: boolean; error?: string }
    setCredOk(res.ok)
    setCredMsg(res.ok ? '引擎就绪' : (res.error ?? ''))
    setEngine(e => e) // no-op keep
  }

  React.useEffect(() => {
    void checkCredential()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine])

  const handleGenerate = async (): Promise<void> => {
    if (!product.trim()) {
      setError('请填写产品名')
      return
    }
    setLoading(true)
    setError('')
    try {
      const sb = (await window.electronAPI.paa.marketing.creative.genStoryboard({
        product: product.trim(),
        category: category.trim() || '通用',
        sellingPoints: sellingPoints.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        targetAudience: '目标人群',
        platform,
        duration,
        textInput: product.trim(),
      })) as { shots: StoryboardShotView[] }
      setStoryboard(sb?.shots ?? [])
    } catch (e) {
      setError((e as Error).message || '生成失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-lg border border-border/50 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Clapperboard size={15} className="text-foreground/45" />
        <span className="text-[13px] font-medium text-foreground/85">广告视频生成</span>
        <div className="flex-1" />
        <span className={`flex items-center gap-1 text-[11px] ${credOk === null ? 'text-foreground/40' : credOk ? 'text-emerald-600' : 'text-amber-600'}`}>
          {credOk === null ? <Loader2 size={11} className="animate-spin" /> : credOk ? <Check size={11} /> : <AlertTriangle size={11} />}
          {engine}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <input
          value={product}
          onChange={(e) => setProduct(e.target.value)}
          placeholder="产品名"
          className="col-span-2 px-2.5 py-1.5 rounded-lg border border-border/50 bg-background text-[13px] focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="品类"
          className="px-2.5 py-1.5 rounded-lg border border-border/50 bg-background text-[13px] focus:outline-none"
        />
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value as typeof platform)}
          className="px-2 py-1.5 rounded-lg border border-border/50 bg-background text-[13px] focus:outline-none"
        >
          <option value="xiaohongshu">小红书</option>
          <option value="douyin">抖音</option>
          <option value="bilibili">B站</option>
          <option value="weibo">微博</option>
        </select>
        <input
          value={sellingPoints}
          onChange={(e) => setSellingPoints(e.target.value)}
          placeholder="卖点（逗号分隔）"
          className="col-span-2 px-2.5 py-1.5 rounded-lg border border-border/50 bg-background text-[13px] focus:outline-none"
        />
      </div>

      {error && <div className="text-[12px] text-red-500">{error}</div>}

      <div className="flex gap-2">
        <button
          onClick={() => void handleGenerate()}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[13px] font-medium disabled:opacity-50"
        >
          {loading && <Loader2 size={13} className="animate-spin" />}
          生成分镜
        </button>
        {credMsg && !credOk && <span className="text-[11px] text-amber-600 self-center">{credMsg}</span>}
      </div>

      {storyboard && storyboard.length > 0 && (
        <div className="space-y-1.5 pt-1 border-t border-border/40">
          <div className="text-[11px] text-foreground/50">分镜脚本（{storyboard.length} 镜 · {duration}s）</div>
          {storyboard.map((shot) => (
            <details key={shot.shotId} className="group rounded-md border border-border/30 bg-foreground/[0.02]">
              <summary className="flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer text-[12px]">
                <ChevronDown size={11} className="transition-transform group-open:rotate-180" />
                <span className="font-medium text-foreground/75">{shot.shotId}</span>
                <span className="text-foreground/40">{shot.duration}s · {shot.scene}</span>
              </summary>
              <div className="px-4 pb-2 text-[12px] text-foreground/60 space-y-0.5">
                <div><span className="text-foreground/40">画面：</span>{shot.visualDescription}</div>
                {shot.narration && <div><span className="text-foreground/40">旁白：</span>{shot.narration}</div>}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}

export default CreativeVideoPanel
