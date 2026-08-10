/**
 * InfluencerModuleView — 工作模块「达人 influencer」入口
 *
 * 达人营销领域包（方案 v4）：KOL/influencer 库、brief、达人稿件三态审核、
 * 内容数据追踪，并内嵌共享素材能力（图文+视频生成）。
 *
 * M0 为骨架：顶栏返回对话 + 子视图切换，业务面板逐步填充。
 */
import * as React from 'react'
import { ArrowLeft, Users, FileCheck2, BarChart3 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { activeViewAtom } from '@/atoms/active-view'
import { CreativeVideoPanel } from '@/components/marketing/CreativeVideoPanel'
import { useSetAtom } from 'jotai'

type InfluencerSubView = 'talents' | 'reviews' | 'tracking'

const SUB_VIEWS: { id: InfluencerSubView; label: string; icon: React.ReactNode }[] = [
  { id: 'talents', label: '达人库', icon: <Users size={11} /> },
  { id: 'reviews', label: '稿件审核', icon: <FileCheck2 size={11} /> },
  { id: 'tracking', label: '内容追踪', icon: <BarChart3 size={11} /> },
]

export function InfluencerModuleView(): React.ReactElement {
  const setActiveView = useSetAtom(activeViewAtom)
  const [subView, setSubView] = React.useState<InfluencerSubView>('talents')

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 flex-shrink-0">
        <button
          onClick={() => setActiveView('conversations')}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[13px] text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/85 transition-colors titlebar-no-drag"
        >
          <ArrowLeft size={15} />
          返回对话
        </button>
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground/75">
          <Users size={15} className="text-foreground/45" />
          达人
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-0.5 rounded-lg bg-foreground/[0.04] p-0.5">
          {SUB_VIEWS.map(({ id, label, icon }) => (
            <button
              key={id}
              onClick={() => setSubView(id)}
              className={cn(
                'px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors inline-flex items-center gap-1 titlebar-no-drag',
                subView === id ? 'bg-background text-foreground shadow-sm' : 'text-foreground/50 hover:text-foreground/80'
              )}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-4 space-y-4 text-[13px] text-foreground/70">
          {subView === 'talents' && (
            <div className="space-y-4">
              <CreativeVideoPanel />
              <InfluencerPlaceholder title="达人库" desc="KOL / influencer 库、圈选、CRM（能力包已订阅）" />
            </div>
          )}
          {subView === 'reviews' && <InfluencerPlaceholder title="稿件审核" desc="达人稿件三态审核（红/黄/绿）机器人，飞书桥接" />}
          {subView === 'tracking' && <InfluencerPlaceholder title="内容追踪" desc="达人内容数据追踪与效果记录" />}
        </div>
      </div>
    </div>
  )
}

function InfluencerPlaceholder({ title, desc }: { title: string; desc: string }): React.ReactElement {
  return (
    <div className="rounded-lg border border-border/50 p-4">
      <div className="font-medium text-foreground/85 mb-1">{title}</div>
      <div className="text-foreground/50">{desc}</div>
    </div>
  )
}

export default InfluencerModuleView
