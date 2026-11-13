/**
 * 会话恢复：从旧版多标签持久化结构迁移出单个会话。
 *
 * 历史背景：早期版本支持多标签（{ tabs, activeTabId }），更早还有分屏
 * （{ tabs, splitLayout }）。多标签移除后主区只渲染一个会话，因此升级时
 * 只需挑出"当时激活的那个"，其余标签丢弃。
 *
 * 边界：纯函数，不读 settings、不碰 atom；任何畸形输入返回 null，
 * 由调用方回落欢迎页而不是抛错。
 */

import type { PersistedSessionState } from '@/types/settings'

interface LegacyTabItemLike {
  type?: unknown
  sessionId?: unknown
}

interface LegacyTabStateWithSplitLayout {
  splitLayout?: {
    focusedPanelIndex?: number
    panels?: Array<{ activeTabId?: string | null }>
  }
}

/** 从旧版 splitLayout 结构中提取原焦点面板的 activeTabId。 */
function extractLegacyActiveTabId(tabState: unknown): string | null {
  if (!tabState || typeof tabState !== 'object') return null
  const panels = (tabState as LegacyTabStateWithSplitLayout).splitLayout?.panels
  if (!Array.isArray(panels) || panels.length === 0) return null
  const focusedIndex = (tabState as LegacyTabStateWithSplitLayout).splitLayout?.focusedPanelIndex ?? 0
  return panels[focusedIndex]?.activeTabId ?? panels[0]?.activeTabId ?? null
}

/**
 * 从旧 tabState 迁移出单个会话。
 *
 * 选择顺序：activeTabId → splitLayout 焦点面板 → 第一个可用标签。
 * 返回 null 表示没有可恢复的会话。
 */
export function migrateLegacyTabState(
  tabState: unknown,
  validSessionIds: ReadonlySet<string>,
): PersistedSessionState | null {
  if (!tabState || typeof tabState !== 'object') return null
  const state = tabState as { tabs?: unknown; activeTabId?: unknown }
  const tabs = Array.isArray(state.tabs) ? (state.tabs as LegacyTabItemLike[]) : []
  const usable = tabs.filter(
    (t): t is LegacyTabItemLike & { type: 'chat' | 'agent'; sessionId: string } =>
      typeof t?.sessionId === 'string' &&
      (t.type === 'chat' || t.type === 'agent') &&
      validSessionIds.has(t.sessionId),
  )
  if (usable.length === 0) return null

  const preferred = typeof state.activeTabId === 'string'
    ? state.activeTabId
    : extractLegacyActiveTabId(tabState)
  const active = usable.find((t) => t.sessionId === preferred) ?? usable[0]!

  return {
    mode: active.type,
    conversationId: active.type === 'chat' ? active.sessionId : null,
    agentSessionId: active.type === 'agent' ? active.sessionId : null,
  }
}
