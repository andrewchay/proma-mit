/**
 * CapabilitiesView — 应用中心 / 领域工作台视图
 *
 * 由顶部菜单栏「应用中心 → 领域工作台」触发。
 * 展示并管理已订阅的领域能力包（达人 influencer / 广告投放 paid-media / 共享素材）。
 */
import * as React from 'react'
import { ArrowLeft, Layers } from 'lucide-react'
import { activeViewAtom } from '@/atoms/active-view'
import { useSetAtom } from 'jotai'
import { CapabilityCenterPanel } from '@/components/settings/CapabilityCenterPanel'

export function CapabilitiesView(): React.ReactElement {
  const setActiveView = useSetAtom(activeViewAtom)

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
          <Layers size={15} className="text-foreground/45" />
          应用中心
        </div>
        <div className="flex-1" />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-5">
          <CapabilityCenterPanel />
        </div>
      </div>
    </div>
  )
}

export default CapabilitiesView
