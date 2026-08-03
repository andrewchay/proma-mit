/**
 * Active View Atom - 主内容区视图状态
 *
 * 控制 MainArea 显示的内容：
 * - conversations: 对话视图（Chat/Agent 模式内容）
 * - workflow: Workflow 工作台
 * - projects / calendar / automation: 工作模块（由工作模块注册表驱动，见 atoms/work-module-registry.ts）
 */

import { atom } from 'jotai'

export type ActiveView = 'conversations' | 'workflow' | 'projects' | 'calendar' | 'automation'

/** 当前活跃视图（不持久化，每次启动默认显示对话） */
export const activeViewAtom = atom<ActiveView>('conversations')
