/**
 * PermissionBanner — Agent 权限请求横幅
 *
 * 内联在 Agent 对话流底部，当有待处理的权限请求时显示。
 * 显示工具名、命令内容、危险等级，提供允许/拒绝/总是允许操作。
 * 支持队列模式：多个并发请求按 FIFO 逐个展示。
 *
 * 视觉与 AskUserBanner 保持一致的卡片式风格：
 * - 危险等级用图标 + 徽章标识（safe=绿 / normal=主色 / dangerous=琥珀）
 * - 决策项用卡片式选项行呈现，支持 ↑↓ 键盘导航 + Enter 确认
 * - 保留原有 Enter 快捷允许与"本次会话总是允许"能力
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  Check,
  CheckCircle2,
  Circle,
  X,
  Terminal,
  FileCode2,
  AlertTriangle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { allPendingPermissionRequestsAtom, agentStreamingStatesAtom, finalizeStreamingActivities } from '@/atoms/agent-atoms'
import type { DangerLevel } from '@proma/shared'

/** 危险等级对应的样式 */
const DANGER_STYLES: Record<DangerLevel, { icon: typeof Shield; iconColor: string; badgeClass: string; label: string }> = {
  safe: {
    icon: ShieldCheck,
    iconColor: 'text-green-600',
    badgeClass: 'bg-green-500/10 text-green-700 dark:text-green-300',
    label: '安全',
  },
  normal: {
    icon: Shield,
    iconColor: 'text-primary',
    badgeClass: 'bg-primary/10 text-primary',
    label: '常规',
  },
  dangerous: {
    icon: ShieldAlert,
    iconColor: 'text-amber-600',
    badgeClass: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    label: '危险',
  },
}

/** 解析工具显示名称（MCP 工具显示 server / tool） */
function formatToolName(toolName: string): string {
  const parts = toolName.split('__')
  if (parts[0] === 'mcp' && parts.length >= 3) {
    return `${parts[1]} / ${parts.slice(2).join('__')}`
  }
  return toolName
}

/** PermissionBanner 属性接口 */
interface PermissionBannerProps {
  sessionId: string
}

/** 决策选项 */
type Decision = 'allow' | 'allowAlways' | 'deny'

export function PermissionBanner({ sessionId }: PermissionBannerProps): React.ReactElement | null {
  const [allRequests, setAllRequests] = useAtom(allPendingPermissionRequestsAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const requests = allRequests.get(sessionId) ?? []
  const [responding, setResponding] = React.useState(false)
  const [focusedIdx, setFocusedIdx] = React.useState(0)
  const respondRef = React.useRef<(behavior: 'allow' | 'deny', alwaysAllow?: boolean) => void>()

  const request = requests[0] ?? null

  // 决策选项构建（根据工具类型决定是否展示"总是允许"）
  const requiresPerActionApproval = request ? (
    (request.toolName.startsWith('ComputerUse') && request.toolName !== 'ComputerUseStatus')
    || new Set(['WebBridgeDownload', 'WebBridgeUpload']).has(request.toolName)
  ) : false

  const decisions = React.useMemo<Array<{ value: Decision; label: string; description: string }>>(() => {
    if (!request) return []
    const items: Array<{ value: Decision; label: string; description: string }> = [
      { value: 'allow', label: '允许', description: '仅允许本次操作' },
    ]
    if (!requiresPerActionApproval) {
      items.push({ value: 'allowAlways', label: '本次会话总是允许', description: '本会话内不再询问同类操作' })
    }
    items.push({ value: 'deny', label: '拒绝', description: '拒绝本次操作并继续' })
    return items
  }, [request, requiresPerActionApproval])

  // 键盘导航：↑↓ 选择决策，Enter 确认
  React.useEffect(() => {
    if (!request || decisions.length === 0) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusedIdx((prev) => {
          const step = e.key === 'ArrowDown' ? 1 : -1
          return (prev + step + decisions.length) % decisions.length
        })
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        const decision = decisions[focusedIdx]
        if (decision) {
          respondRef.current?.(
            decision.value === 'deny' ? 'deny' : 'allow',
            decision.value === 'allowAlways',
          )
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [request?.requestId, request, decisions, focusedIdx])

  /** 关闭权限请求 & 终止 Agent */
  const handleDismiss = (): void => {
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

  const dangerStyle = DANGER_STYLES[request.dangerLevel] ?? DANGER_STYLES.normal
  const IconComponent = dangerStyle.icon
  const isDangerous = request.dangerLevel === 'dangerous'

  /** 响应权限请求 */
  const respond = async (behavior: 'allow' | 'deny', alwaysAllow = false): Promise<void> => {
    if (responding) return
    setResponding(true)

    try {
      await window.electronAPI.respondPermission({
        requestId: request.requestId,
        behavior,
        alwaysAllow,
      })
      // 移除已响应的请求（FIFO 出队）
      setAllRequests((prev) => {
        const map = new Map(prev)
        const current = map.get(sessionId) ?? []
        const newValue = current.filter((r) => r.requestId !== request.requestId)
        if (newValue.length === 0) map.delete(sessionId)
        else map.set(sessionId, newValue)
        return map
      })
    } catch (error) {
      console.error('[PermissionBanner] 响应失败:', error)
    } finally {
      setResponding(false)
      setFocusedIdx(0)
    }
  }

  respondRef.current = respond

  const hasToolInput = Object.keys(request.toolInput).length > 0

  return (
    <div
      className={`mx-4 mb-3 rounded-xl bg-card shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-200 border border-border/50 ${
        isDangerous ? 'ring-1 ring-amber-500/40' : ''
      }`}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <IconComponent className={`size-4 ${dangerStyle.iconColor}`} />
          <span className="text-sm font-semibold text-foreground">
            {isDangerous ? '危险操作需要确认' : '工具调用需要确认'}
          </span>
          <span className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${dangerStyle.badgeClass}`}>
            {dangerStyle.label}
          </span>
          {requests.length > 1 && (
            <span className="text-xs text-muted-foreground">
              (+{requests.length - 1})
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground font-mono">
            {request.sdkDisplayName ?? formatToolName(request.toolName)}
          </span>
          <button
            type="button"
            className="size-5 flex items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
            onClick={handleDismiss}
            title="关闭并终止 Agent"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {/* 操作内容 */}
      <div className="px-4 pb-2 space-y-1.5">
        {request.sdkTitle && (
          <p className="text-sm text-foreground">{request.sdkTitle}</p>
        )}
        {request.sdkDescription && request.sdkDescription !== request.sdkTitle && (
          <p className="text-xs text-muted-foreground">{request.sdkDescription}</p>
        )}

        {/* 命令代码块 */}
        {request.command ? (
          <div className="rounded-lg bg-muted/40 p-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
              <Terminal className="size-3" />
              将执行的命令
            </div>
            <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-[140px] overflow-y-auto text-foreground/90">
              {request.command}
            </pre>
          </div>
        ) : hasToolInput && !request.sdkTitle ? (
          <div className="rounded-lg bg-muted/40 p-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
              <FileCode2 className="size-3" />
              工具参数
            </div>
            <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-[140px] overflow-y-auto text-foreground/90">
              {JSON.stringify(request.toolInput, null, 2)}
            </pre>
          </div>
        ) : null}

        {/* 决策原因（SDK 提供） */}
        {request.decisionReason && (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <AlertTriangle className="size-3 mt-0.5 shrink-0" />
            <span>{request.decisionReason}</span>
          </p>
        )}
      </div>

      {/* 决策选项（卡片式单选） */}
      <div className="flex flex-col gap-1.5 px-4 pb-2.5">
        {decisions.map((decision, idx) => {
          const selected = idx === focusedIdx
          const isDeny = decision.value === 'deny'
          const isAllowAlways = decision.value === 'allowAlways'
          return (
            <button
              key={decision.value}
              type="button"
              onClick={() => respond(decision.value === 'deny' ? 'deny' : 'allow', decision.value === 'allowAlways')}
              disabled={responding}
              className={`
                group flex items-center gap-3 w-full px-3 py-2 rounded-lg border text-left transition-all outline-none
                ${selected
                  ? 'bg-primary/5 border-primary text-primary-foreground shadow-sm'
                  : 'bg-card border-border/60 text-foreground/80 hover:border-primary/40 hover:bg-muted/30'
                }
                ${isDeny ? (selected ? 'border-destructive/60 bg-destructive/5' : 'hover:border-destructive/40') : ''}
                ${selected ? 'ring-2 ring-primary/40 ring-offset-1 ring-offset-card' : ''}
                ${responding ? 'opacity-60 cursor-not-allowed' : ''}
              `}
            >
              <span className={`mt-0.5 shrink-0 ${selected ? (isDeny ? 'text-destructive' : 'text-primary') : 'text-muted-foreground/50 group-hover:text-primary/60'}`}>
                {selected
                  ? <CheckCircle2 className="size-4" />
                  : <Circle className="size-4" />}
              </span>
              <div className="flex-1 min-w-0">
                <div className={`text-xs font-medium ${selected ? 'text-foreground' : 'text-foreground/90'}`}>
                  {decision.label}
                  {isAllowAlways && <span className="ml-1.5 text-[10px] text-muted-foreground/70 font-normal">本会话记忆</span>}
                </div>
                <div className={`text-[11px] mt-0.5 leading-relaxed ${selected ? 'text-primary/80' : 'text-muted-foreground'}`}>
                  {decision.description}
                </div>
              </div>
              <span className={`text-[10px] shrink-0 mt-0.5 ${selected ? 'text-primary/60' : 'text-muted-foreground/40'}`}>
                {idx + 1}
              </span>
            </button>
          )
        })}
      </div>

      {/* 底部提示 */}
      <div className="flex items-center justify-between gap-2 px-4 pb-3">
        <span className="text-[10px] text-muted-foreground/40">
          ↑↓ 选择 · Enter 确认
        </span>
        <div className="flex items-center gap-1.5">
          {!requiresPerActionApproval && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => respond('allow', true)}
              disabled={responding}
              className="h-7 px-3 text-xs text-muted-foreground hover:text-foreground"
            >
              <ShieldCheck className="size-3 mr-1" />
              总是允许
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => respond('deny')}
            disabled={responding}
            className="h-7 px-3 text-xs text-muted-foreground hover:text-destructive"
          >
            <X className="size-3 mr-1" />
            拒绝
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => respond('allow')}
            disabled={responding}
            className="h-7 px-3 text-xs"
          >
            <Check className="size-3 mr-1" />
            允许
          </Button>
        </div>
      </div>
    </div>
  )
}
