/**
 * Active View Atom - 主内容区视图状态
 *
 * 控制 MainArea 显示的内容：
 * - conversations: 对话视图（Chat/Agent 模式内容）
 * - workflow: Workflow 工作台
 * - knowledge: 知识库（免费版基础能力，索引模式）
 * - analysis: 分析引擎（免费版基础能力）
 * - projects / calendar / automation: 工作模块（由工作模块注册表驱动，见 atoms/work-module-registry.ts）
 * - workspace-config: 工作空间配置（Agent 工作区能力：Skills / MCP / 内置工具等），
 *   与其它工作模块一致以右侧主区独立页面呈现，不再走设置弹窗
 */

import { atom } from 'jotai'

export type ActiveView = 'conversations' | 'workflow' | 'proactive' | 'knowledge' | 'analysis' | 'projects' | 'calendar' | 'influencer' | 'paid-media' | 'outbound-sourcing' | 'new-media' | 'research' | 'capabilities' | 'workspace-config'

/** 当前活跃视图（不持久化，每次启动默认显示对话） */
export const activeViewAtom = atom<ActiveView>('conversations')
