import type { createStore } from 'jotai'
import {
  agentStreamingStatesAtom, liveMessagesMapAtom, agentSessionPendingFilesAtom,
  agentSessionStreamingStateAtomFamily, agentSessionDraftAtomFamily, agentSessionDraftHtmlAtomFamily,
  agentPendingFilesAtomFamily, backgroundTasksAtomFamily, sessionPersistedPermissionModeAtom, sessionExistsAtom,
} from '@/atoms/agent-atoms'

/** 已删除或归档会话在运行中仍须保留实时状态，直到该运行结束。 */
export function cleanupRetiredAgentSession(store: ReturnType<typeof createStore>, id: string): boolean {
  if (store.get(agentStreamingStatesAtom).get(id)?.running) return false
  const remove = <T,>(map: Map<string, T>): Map<string, T> => {
    if (!map.has(id)) return map
    const next = new Map(map)
    next.delete(id)
    return next
  }
  for (const file of store.get(agentSessionPendingFilesAtom).get(id) ?? []) {
    if (file.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(file.previewUrl)
    window.__pendingAgentFileData?.delete(file.id)
  }
  store.set(agentSessionPendingFilesAtom, remove)
  store.set(agentStreamingStatesAtom, remove)
  store.set(liveMessagesMapAtom, remove)
  agentSessionStreamingStateAtomFamily.remove(id)
  agentSessionDraftAtomFamily.remove(id)
  agentSessionDraftHtmlAtomFamily.remove(id)
  agentPendingFilesAtomFamily.remove(id)
  backgroundTasksAtomFamily.remove(id)
  sessionPersistedPermissionModeAtom.remove(id)
  sessionExistsAtom.remove(id)
  return true
}
