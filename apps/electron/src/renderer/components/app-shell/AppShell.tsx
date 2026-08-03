/**
 * AppShell - 应用主布局容器
 *
 * 布局结构：[LeftSidebar 可折叠/可拖宽] | [MainArea: TabBar + TabContent] | [RightSidePanel 可折叠/可拖宽]
 *
 * MainArea 支持多标签页，Settings 视图为独立覆盖。
 *
 * 布局规则：
 * - 左侧边栏、中间主区、右侧文件面板两两之间无视觉间隔（不设 padding）。
 * - 左侧边栏宽度可拖拽调整（min 200 / max 440），持久化到 localStorage。
 * - 右侧文件面板打开时紧贴主区右侧，关闭时主区保留窗口右缘 padding。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { LeftSidebar } from './LeftSidebar'
import { RightSidePanel } from './RightSidePanel'
import { MainArea } from '@/components/tabs/MainArea'
import { AppShellProvider, type AppShellContextType } from '@/contexts/AppShellContext'
import { appModeAtom } from '@/atoms/app-mode'
import { agentSidePanelWidthAtom, currentAgentSessionIdAtom, currentSessionSidePanelOpenAtom } from '@/atoms/agent-atoms'
import { sidebarCollapsedAtom } from '@/atoms/tab-atoms'
import { sidebarWidthAtom } from '@/atoms/sidebar-atoms'
import { WindowControls } from '@/components/WindowControls'
import { detectIsWindows } from '@/lib/platform'
import { cn } from '@/lib/utils'

const MIN_RIGHT_PANEL_WIDTH = 220
const MAX_RIGHT_PANEL_WIDTH = 420

const MIN_LEFT_SIDEBAR_WIDTH = 200
const MAX_LEFT_SIDEBAR_WIDTH = 440

function clampRightPanelWidth(width: number): number {
  return Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(MAX_RIGHT_PANEL_WIDTH, width))
}

function clampLeftSidebarWidth(width: number): number {
  return Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.min(MAX_LEFT_SIDEBAR_WIDTH, width))
}

export interface AppShellProps {
  /** Context 值，用于传递给子组件 */
  contextValue: AppShellContextType
}

export function AppShell({ contextValue }: AppShellProps): React.ReactElement {
  const appMode = useAtomValue(appModeAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const isPanelOpen = useAtomValue(currentSessionSidePanelOpenAtom)
  const showRightPanel = appMode === 'agent' && !!currentSessionId
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)

  // 右侧面板可拖拽宽度
  const [rightPanelWidth, setRightPanelWidth] = useAtom(agentSidePanelWidthAtom)
  const draggingRight = React.useRef(false)
  const clampedRightPanelWidth = clampRightPanelWidth(rightPanelWidth)

  // 左侧边栏可拖拽宽度
  const [sidebarWidth, setSidebarWidth] = useAtom(sidebarWidthAtom)
  const [sidebarResizing, setSidebarResizing] = React.useState(false)
  const draggingLeft = React.useRef(false)
  const clampedSidebarWidth = clampLeftSidebarWidth(sidebarWidth)

  React.useEffect(() => {
    if (clampedRightPanelWidth !== rightPanelWidth) {
      setRightPanelWidth(clampedRightPanelWidth)
    }
  }, [clampedRightPanelWidth, rightPanelWidth, setRightPanelWidth])

  React.useEffect(() => {
    if (clampedSidebarWidth !== sidebarWidth) {
      setSidebarWidth(clampedSidebarWidth)
    }
  }, [clampedSidebarWidth, sidebarWidth, setSidebarWidth])

  const handleRightMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRight.current = true
    const startX = e.clientX
    const startWidth = clampedRightPanelWidth
    let rafId = 0

    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingRight.current) return
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const delta = startX - ev.clientX
        const newWidth = clampRightPanelWidth(startWidth + delta)
        setRightPanelWidth(newWidth)
      })
    }

    const onMouseUp = () => {
      draggingRight.current = false
      if (rafId) cancelAnimationFrame(rafId)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [clampedRightPanelWidth, setRightPanelWidth])

  const handleLeftMouseDown = React.useCallback((e: React.MouseEvent) => {
    if (sidebarCollapsed) return
    e.preventDefault()
    e.stopPropagation()
    draggingLeft.current = true
    setSidebarResizing(true)
    const startX = e.clientX
    const startWidth = clampedSidebarWidth
    let rafId = 0

    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingLeft.current) return
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const delta = ev.clientX - startX
        const newWidth = clampLeftSidebarWidth(startWidth + delta)
        setSidebarWidth(newWidth)
      })
    }

    const onMouseUp = () => {
      draggingLeft.current = false
      setSidebarResizing(false)
      if (rafId) cancelAnimationFrame(rafId)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }, [sidebarCollapsed, clampedSidebarWidth, setSidebarWidth])

  return (
    <AppShellProvider value={contextValue}>
      {/* 可拖动标题栏区域，用于窗口拖动。
          Windows 上必须避开右上角的 WindowControls 区域（buttons ~118px + 8px buffer = 126px），
          否则 drag-region 与按钮区的 hitmask 重叠会让 OS 把单击当成标题栏点击，
          表现为"按钮要双击才响应"。 */}
      <div
        className={cn(
          'titlebar-drag-region fixed top-0 left-0 h-[50px] z-50',
          isWindows ? 'right-[126px]' : 'right-0'
        )}
      />

      {/* Windows 自定义窗口控制按钮（最小化/最大化/关闭） */}
      <WindowControls />

      <div className="shell-bg relative h-screen w-screen flex overflow-hidden bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-950 dark:to-zinc-900">
        {/* 左侧边栏：可折叠、可拖宽。仅保留窗口边缘 padding（p-2 左右），右侧与主区无间隔 */}
        <div className="p-2 pr-0 relative z-[60]">
          <LeftSidebar width={clampedSidebarWidth} resizing={sidebarResizing} />
        </div>

        {/* 左侧拖拽手柄 — 位于侧边栏与主区之间（侧边栏展开时可用） */}
        {!sidebarCollapsed && (
          <div
            className={cn(
              'absolute z-[70] top-0 bottom-0 w-[8px] -translate-x-1/2 cursor-col-resize transition-colors',
              sidebarResizing ? 'bg-primary/50' : 'hover:bg-primary/30'
            )}
            style={{ left: 8 + clampedSidebarWidth }}
            onMouseDown={handleLeftMouseDown}
            title="拖拽调整侧边栏宽度"
          />
        )}

        {/* 中间容器：侧边栏展开时左侧无间隔；右侧面板打开时右侧无间隔 */}
        <div
          className={cn(
            'flex-1 min-w-0 relative z-[60] p-2',
            sidebarCollapsed ? 'pl-2' : 'pl-0',
            showRightPanel && isPanelOpen ? 'pr-0' : 'pr-2'
          )}
        >
          {/* 主内容区域（TabBar + TabContent） */}
          <MainArea />
        </div>

        {/* 右侧边栏：Agent 文件面板，拖拽手柄在间距中间 */}
        {showRightPanel && (
          <div className={cn('relative z-[60] flex items-stretch transition-[padding] duration-300 ease-in-out', isPanelOpen ? 'p-2 pl-0' : 'p-0')}>
            {/* 拖拽手柄 — 绝对定位，居中于主区域和右侧面板的缝隙 */}
            {isPanelOpen && (
              <div
                className="absolute left-0 top-0 bottom-0 w-[8px] -translate-x-1/2 cursor-col-resize active:bg-primary/50 transition-colors z-10"
                onMouseDown={handleRightMouseDown}
              />
            )}
            <RightSidePanel width={clampedRightPanelWidth} />
          </div>
        )}
      </div>
    </AppShellProvider>
  )
}
