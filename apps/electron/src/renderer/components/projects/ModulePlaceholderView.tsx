/**
 * ModulePlaceholderView - 企业级工作模块占位视图（项目管理 / 任务 / 日程）
 *
 * 这些模块参考 ~/LLM/PAA 的实现，待 PAA 侧完成后迁移接入。
 * 本视图保持独立挂载点，确保后续接入无需改动左侧导航结构。
 */

import type * as React from 'react'
import { useAtom } from 'jotai'
import { FolderKanban, ListChecks, CalendarDays, Construction, ArrowLeft, type LucideIcon } from 'lucide-react'
import { activeViewAtom } from '@/atoms/active-view'

const MODULE_META: Record<'projects' | 'tasks' | 'calendar', { label: string; icon: LucideIcon; description: string }> = {
  projects: {
    label: '项目管理',
    icon: FolderKanban,
    description: '项目 / 任务 / 子任务 / 看板 / 会议纪要，参考 PAA 的 project 模块实现，待完成后接入。',
  },
  tasks: {
    label: '任务',
    icon: ListChecks,
    description: '任务中心与待办管理，参考 PAA 的任务模块实现，待完成后接入。',
  },
  calendar: {
    label: '日程',
    icon: CalendarDays,
    description: '日程安排与日历视图，参考 PAA 的 schedule 模块实现，待完成后接入。',
  },
}

interface ModulePlaceholderViewProps {
  moduleId: 'projects' | 'tasks' | 'calendar'
}

export function ModulePlaceholderView({ moduleId }: ModulePlaceholderViewProps): React.ReactElement {
  const [, setActiveView] = useAtom(activeViewAtom)
  const meta = MODULE_META[moduleId]
  const Icon = meta.icon

  const handleBack = (): void => {
    setActiveView('conversations')
  }

  return (
    <div className="h-full flex flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50">
        <button
          onClick={handleBack}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[13px] text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/85 transition-colors"
        >
          <ArrowLeft size={15} />
          返回对话
        </button>
        <div className="flex-1" />
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground/75">
          <Icon size={16} className="text-foreground/45" />
          {meta.label}
        </div>
      </div>

      {/* 主体：占位提示 */}
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center max-w-md px-6">
          <div className="size-12 flex items-center justify-center rounded-2xl bg-primary/5 text-primary/60">
            <Construction size={24} />
          </div>
          <div className="text-[15px] font-medium text-foreground/85">
            {meta.label}模块建设中
          </div>
          <p className="text-[12px] leading-5 text-foreground/45">
            该模块将提供完整的{meta.label}能力（{meta.description}）。
            <br />
            当前请先在左侧「项目」列表中查看进行中的项目与会话。
          </p>
        </div>
      </div>
    </div>
  )
}
