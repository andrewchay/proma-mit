import type { PromaPermissionMode } from '@gravitas/shared'

/** 普通 Agent Header 中可交互选择的权限模式；safe 仅供历史会话/受控策略兼容。 */
export const SELECTABLE_AGENT_PERMISSION_MODES = ['plan', 'auto', 'bypassPermissions'] as const satisfies readonly PromaPermissionMode[]

export function getNextSelectableAgentPermissionMode(current: PromaPermissionMode): PromaPermissionMode {
  const currentIndex = SELECTABLE_AGENT_PERMISSION_MODES.indexOf(current as (typeof SELECTABLE_AGENT_PERMISSION_MODES)[number])
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % SELECTABLE_AGENT_PERMISSION_MODES.length
  return SELECTABLE_AGENT_PERMISSION_MODES[nextIndex]!
}
