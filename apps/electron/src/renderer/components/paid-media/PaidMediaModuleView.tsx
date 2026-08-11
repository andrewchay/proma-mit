/**
 * PaidMediaModuleView — 工作模块「广告投放 paid-media」入口
 *
 * 广告投放领域包（方案 v4）：广告/预算/数据看板、调控建议 + 审批流、
 * 调控规则（红线/业务/软提示）。首期不含真实媒体 API 写钱。
 *
 * M0 为骨架：顶栏返回对话 + 子视图切换，业务面板逐步填充。
 */
import * as React from 'react'
import { ArrowLeft, Megaphone, Gauge, ClipboardCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { activeViewAtom } from '@/atoms/active-view'
import { useSetAtom } from 'jotai'
import { PaidCampaignsPanel } from './PaidCampaignsPanel'
import { PaidControlPanel } from './PaidControlPanel'
import { PaidRulesPanel } from './PaidRulesPanel'

type PaidSubView = 'campaigns' | 'control' | 'rules'

const SUB_VIEWS: { id: PaidSubView; label: string; icon: React.ReactNode }[] = [
  { id: 'campaigns', label: '投放计划', icon: <Megaphone size={11} /> },
  { id: 'control', label: '调控审批', icon: <Gauge size={11} /> },
  { id: 'rules', label: '调控规则', icon: <ClipboardCheck size={11} /> },
]

export function PaidMediaModuleView(): React.ReactElement {
  const setActiveView = useSetAtom(activeViewAtom)
  const [subView, setSubView] = React.useState<PaidSubView>('campaigns')

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
          <Megaphone size={15} className="text-foreground/45" />
          广告投放
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
          {subView === 'campaigns' && <PaidCampaignsPanel />}
          {subView === 'control' && <PaidControlPanel />}
          {subView === 'rules' && <PaidRulesPanel />}
        </div>
      </div>
    </div>
  )
}

export default PaidMediaModuleView
