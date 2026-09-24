/**
 * SettingsModuleView — 应用设置（右侧主区独立页面）
 *
 * 与 workspace-config 同模式：点击侧边栏头像后在主内容区打开完整设置页，而不是弹出设置弹窗。
 * 主体直接复用设置弹窗的 SettingsPanel，保证所有 Tab 能力与弹窗完全一致，避免两套实现漂移；
 * 面板的关闭（X / Cmd+W / 未保存拦截确认）统一回到对话视图。
 *
 * 顶部返回栏位于全局 50px 窗口拖拽区内，MainArea 模块分支已整体声明 titlebar-no-drag，
 * ModuleBackButton 内部再显式声明一次，保证单独复用时也不会被拖拽层吃掉点击。
 */

import type * as React from 'react'
import { useSetAtom } from 'jotai'
import { Settings } from 'lucide-react'
import { activeViewAtom } from '@/atoms/active-view'
import { ModuleBackButton } from '@/components/app-shell/ModuleBackButton'
import { SettingsPanel } from './SettingsPanel'

export function SettingsModuleView(): React.ReactElement {
  const setActiveView = useSetAtom(activeViewAtom)
  const backToConversations = (): void => setActiveView('conversations')

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 flex-shrink-0 titlebar-no-drag">
        <ModuleBackButton />
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground/75">
          <Settings size={15} className="text-foreground/45" />
          设置
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <SettingsPanel onClose={backToConversations} />
      </div>
    </div>
  )
}
