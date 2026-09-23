/**
 * CapabilitiesView — 专业订阅服务 / 领域能力包视图
 *
 * 由顶部菜单栏「专业订阅服务 → 领域能力包」触发。
 * 展示并管理已订阅的领域能力包（达人 influencer / 广告投放 paid-media / 出海 sourcing / 共享素材）。
 */
import type * as React from 'react'
import { Layers } from 'lucide-react'
import { ModuleBackButton } from '@/components/app-shell/ModuleBackButton'
import { CapabilityCenterPanel } from '@/components/settings/CapabilityCenterPanel'

export function CapabilitiesView(): React.ReactElement {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 flex-shrink-0">
        <ModuleBackButton />
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground/75">
          <Layers size={15} className="text-foreground/45" />
          专业订阅服务
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
