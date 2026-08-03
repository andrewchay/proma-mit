/**
 * Active View Atom - 主内容区视图状态
 *
 * 控制 MainArea 显示的内容：
 * - conversations: 对话视图（Chat/Agent 模式内容）
 * - workflow: Workflow 工作台
 * - projects: 项目管理模块（由 ~/LLM/PAA 迁移接入）
 * - tasks: 任务模块（独立工作模块，暂为占位入口）
 * - calendar: 日程管家模块（由 ~/LLM/PAA 迁移接入）
 * - automation: 自动任务 / 运行中心（独立工作模块）
 */

import { atom } from 'jotai'

export type ActiveView = 'conversations' | 'workflow' | 'projects' | 'tasks' | 'calendar' | 'automation'

/** 当前活跃视图（不持久化，每次启动默认显示对话） */
export const activeViewAtom = atom<ActiveView>('conversations')
