/**
 * McpOAuthBanner — MCP OAuth 授权提示横幅
 *
 * 当 MCP 服务器需要用户完成 OAuth 授权时显示，引导用户在浏览器中完成授权。
 * 授权完成后 DeepLink 会自动清除对应请求；用户也可以手动关闭提示。
 */

import type * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { KeyRound, X, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { allPendingMcpOAuthRequestsAtom, agentStreamingStatesAtom, finalizeStreamingActivities } from '@/atoms/agent-atoms'

interface McpOAuthBannerProps {
  sessionId: string
}

export function McpOAuthBanner({ sessionId }: McpOAuthBannerProps): React.ReactElement | null {
  const [allRequests, setAllRequests] = useAtom(allPendingMcpOAuthRequestsAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const requests = allRequests.get(sessionId) ?? []
  const request = requests[0] ?? null

  const handleDismiss = (): void => {
    setAllRequests((prev) => {
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })
  }

  const handleAbort = (): void => {
    setStreamingStates((prev) => {
      const current = prev.get(sessionId)
      if (!current || !current.running) return prev
      const map = new Map(prev)
      map.set(sessionId, {
        ...current,
        running: false,
        ...finalizeStreamingActivities(current.toolActivities),
      })
      return map
    })
    setAllRequests((prev) => {
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })
    window.electronAPI.stopAgent(sessionId).catch(console.error)
  }

  if (!request) return null

  return (
    <div className="mx-4 mb-3 rounded-xl bg-card shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-primary" />
          <span className="text-sm font-medium">MCP 服务器需要授权</span>
          {requests.length > 1 && (
            <span className="text-xs text-muted-foreground">(+{requests.length - 1})</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground font-mono">{request.serverName}</span>
          <button
            type="button"
            className="size-5 flex items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
            onClick={handleDismiss}
            title="关闭提示"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="px-3 pb-2 space-y-1.5">
        <p className="text-xs text-foreground">
          请在浏览器中完成 <span className="font-medium">{request.serverName}</span> 的 OAuth 授权。
          授权完成后 Proma 会自动继续。
        </p>
        {request.authorizationUrl && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            onClick={() => window.electronAPI.openExternal?.(request.authorizationUrl!)}
          >
            <ExternalLink className="size-3" />
            打开授权页
          </button>
        )}
      </div>

      <div className="flex items-center justify-end gap-1.5 px-3 pb-2.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleAbort}
          className="h-7 px-3 text-xs text-muted-foreground hover:text-destructive"
        >
          终止 Agent
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={handleDismiss}
          className="h-7 px-3 text-xs"
        >
          已完成授权
        </Button>
      </div>
    </div>
  )
}
