import { atom } from 'jotai'
import type { Campaign } from '@gravitas/shared'

/** Campaign 列表 */
export const campaignsAtom = atom<Campaign[]>([])

/** 回收站中的 Campaign 列表 */
export const trashedCampaignsAtom = atom<Campaign[]>([])

/** 当前选中的 Campaign ID */
export const currentCampaignIdAtom = atom<string | null>(null)

/** 创建弹窗开关 */
export const campaignCreateDialogOpenAtom = atom(false)

/** Chat 会话 ID → Campaign ID 映射（用于 Campaign Agent 原生对话） */
export const campaignConversationMapAtom = atom<Map<string, string>>(new Map())

/** Campaign ID → Agent 会话 ID 映射（用于 Campaign Agent 面板） */
export const campaignAgentSessionMapAtom = atom<Map<string, string>>(new Map())
