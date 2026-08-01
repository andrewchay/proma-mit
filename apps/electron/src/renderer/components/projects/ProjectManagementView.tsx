/**
 * ProjectManagementView - 企业级项目管理模块（主视图）
 *
 * 当前为占位入口：真实的项目管理（Project / Task / SubTask / 看板 / 会议纪要）
 * 参考 ~/LLM/PAA 的 project 模块实现，待 PAA 侧完成后迁移接入。
 * 本视图保持独立挂载点，确保后续接入无需改动左侧导航结构。
 */

import type * as React from 'react'
import { useAtom } from 'jotai'
import { FolderKanban, Construction, ArrowLeft } from 'lucide-react'
import { activeViewAtom } from '@/atoms/active-view'

export function ProjectManagementView(): React.ReactElement {
  const [activeView, setActiveView] = useAtom(activeViewAtom)
  void activeView // 保留订阅，供未来模块读取

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
          <FolderKanban size={16} className="text-foreground/45" />
          项目管理
        </div>
      </div>

      {/* 主体：占位提示 */}
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center max-w-md px-6">
          <div className="size-12 flex items-center justify-center rounded-2xl bg-primary/5 text-primary/60">
            <Construction size={24} />
          </div>
          <div className="text-[15px] font-medium text-foreground/85">
            企业级项目管理模块建设中
          </div>
          <p className="text-[12px] leading-5 text-foreground/45">
            该模块将提供完整的项目管理能力（项目 / 任务 / 子任务 / 看板 / 会议纪要），
            参考 PAA 的 project 模块实现，待完成后接入。
            <br />
            当前请先在左侧「项目」列表中查看进行中的项目与会话。
          </p>
        </div>
      </div>
    </div>
  )
}
