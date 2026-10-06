/**
 * ModuleBackButton — 工作模块页统一的「返回对话」入口
 *
 * 所有以右侧主区独立页面呈现的工作模块（知识库 / 分析引擎 / 新媒体运营 / 项目管理 …）
 * 都用它回到 conversations 视图，避免每个模块各写一份样式不同的返回按钮。
 *
 * 顶部落在 AppShell 的全局 50px 窗口拖拽层内。MainArea 的模块分支已整体声明
 * titlebar-no-drag，这里再显式声明一次，保证该组件被单独复用时也不会被拖拽层吃掉点击。
 */

import type * as React from 'react'
import { useSetAtom } from 'jotai'
import { ArrowLeft } from 'lucide-react'
import { activeViewAtom } from '@/atoms/active-view'

export function ModuleBackButton(): React.ReactElement {
  const setActiveView = useSetAtom(activeViewAtom)

  return (
    <button
      onClick={() => setActiveView('conversations')}
      className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[13px] text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/85 transition-colors titlebar-no-drag"
    >
      <ArrowLeft size={15} />
      返回对话
    </button>
  )
}
