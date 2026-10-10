/**
 * PermissionModeSelector — Agent 权限模式切换器
 *
 * 集成在 AgentHeader 中，提供计划、自动审批和完全自动三种可选模式。
 * 历史 safe 会话继续保持原有策略，首次切换进入计划模式。
 * 每个会话独立维护自己的权限模式。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Zap, Compass, Map as MapIcon, Shield } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { agentPermissionModeMapAtom, agentDefaultPermissionModeAtom, sessionPersistedPermissionModeAtom, sessionExistsAtom } from '@/atoms/agent-atoms'
import type { PromaPermissionMode } from '@gravitas/shared'
import { PROMA_PERMISSION_MODE_CONFIG } from '@gravitas/shared'
import { getNextSelectableAgentPermissionMode } from './permission-mode-selector-model'

const MODE_ICONS: Record<PromaPermissionMode, React.ComponentType<{ className?: string }>> = {
  safe: Shield,
  auto: Compass,
  bypassPermissions: Zap,
  plan: MapIcon,
}

interface PermissionModeSelectorProps {
  sessionId: string
}

export function PermissionModeSelector({ sessionId }: PermissionModeSelectorProps): React.ReactElement | null {
  const [modeMap, setModeMap] = useAtom(agentPermissionModeMapAtom)
  const defaultMode = useAtomValue(agentDefaultPermissionModeAtom)
  const persistedSessionMode = useAtomValue(sessionPersistedPermissionModeAtom(sessionId))
  const mode = modeMap.get(sessionId) ?? persistedSessionMode ?? defaultMode
  const sessionExistsInList = useAtomValue(sessionExistsAtom(sessionId))

  // 初始化：如果当前 session 不在 Map 中，按以下优先级读回：
  // 1. session meta.permissionMode（每个 tab 独立持久化，重启恢复各自的值）
  // 2. 默认完全自动模式
  // 注意：只写入当前 session，不回写到 agentDefaultPermissionModeAtom，避免跨会话污染。
  React.useEffect(() => {
    if (!sessionExistsInList) return

    setModeMap((prev: Map<string, PromaPermissionMode>) => {
      if (prev.has(sessionId)) return prev
      const next = new Map(prev)
      next.set(sessionId, persistedSessionMode ?? defaultMode)
      return next
    })
  }, [sessionId, persistedSessionMode, sessionExistsInList, defaultMode, setModeMap])

  /** 循环切换模式 */
  const cycleMode = React.useCallback(async () => {
    const nextMode = getNextSelectableAgentPermissionMode(mode)
    const prevMode = mode

    // 乐观更新当前 session 的模式
    setModeMap((prev: Map<string, PromaPermissionMode>) => {
      const next = new Map(prev)
      next.set(sessionId, nextMode)
      return next
    })

    // 热切换运行中的当前 session；失败时回滚 modeMap 保持 UI/后端一致
    try {
      await window.electronAPI.updateSessionPermissionMode(sessionId, nextMode)
    } catch (error) {
      console.error('[PermissionModeSelector] 运行中切换权限模式失败，回滚 UI:', error)
      setModeMap((prev: Map<string, PromaPermissionMode>) => {
        const next = new Map(prev)
        next.set(sessionId, prevMode)
        return next
      })
    }
  }, [mode, sessionId, setModeMap])

  const config = PROMA_PERMISSION_MODE_CONFIG[mode]
  const Icon = MODE_ICONS[mode]

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={config.label}
            onClick={() => { cycleMode(); requestAnimationFrame(() => document.querySelector<HTMLElement>('.ProseMirror')?.focus()) }}
            className="size-[36px] rounded-full text-foreground/60 hover:text-foreground"
          >
            <Icon className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[200px]">
          <p className="font-medium">{config.label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{config.description}</p>
          <p className="text-xs text-muted-foreground mt-1">点击切换模式</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
