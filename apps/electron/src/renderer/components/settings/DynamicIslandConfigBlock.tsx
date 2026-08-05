/**
 * DynamicIslandConfigBlock — 灵动岛通知配置区块（可嵌入其他设置页面）。
 *
 * 展示：平台支持状态、总开关、测试通知、最近通知列表。
 * 原独立「灵动岛通知」tab 改为嵌入「快捷键管理」页面，不再单独占一个设置入口。
 */

import * as React from 'react'
import { SettingsToggle } from './primitives/SettingsToggle'
import { SettingsCard } from './primitives/SettingsCard'
import { SettingsRow } from './primitives/SettingsRow'
import { SettingsSection } from './primitives/SettingsSection'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { detectIsMac } from '@/lib/platform'
import type { DynamicIslandSessionSnapshot, DynamicIslandState } from '@gravitas/shared'

const LEVEL_LABEL: Record<string, string> = {
  info: '信息',
  success: '成功',
  warning: '警告',
  error: '失败',
  progress: '进行中',
}

const PHASE_LABEL: Record<string, string> = {
  idle: '空闲',
  running: '执行中',
  'needs-interaction': '待处理',
  completed: '已完成',
  error: '需关注',
}

/** 当前活动摘要文本（用于「当前活动」行 description） */
function describePill(pill: DynamicIslandState['pill'] | undefined): string {
  if (!pill) return '暂无 Agent 活动'
  if (pill.sessionCount === 0) return '暂无 Agent 活动'
  if (pill.pendingInteractionCount > 0) return `有 ${pill.pendingInteractionCount} 个会话等待处理`
  if (pill.unreadCompletedCount > 0) return `有 ${pill.unreadCompletedCount} 个已完成/失败待查看`
  if (pill.activeSessionCount > 0) return `${pill.activeSessionCount} 个会话正在执行`
  return '暂无 Agent 活动'
}

/** 当前活动摘要（用于「当前活动」行值） */
function formatPill(pill: DynamicIslandState['pill']): string {
  const parts: string[] = []
  if (pill.pendingInteractionCount > 0) parts.push(`${pill.pendingInteractionCount} 待处理`)
  if (pill.unreadCompletedCount > 0) parts.push(`${pill.unreadCompletedCount} 未读`)
  if (pill.activeSessionCount > 0) parts.push(`${pill.activeSessionCount} 执行中`)
  return parts.length > 0 ? parts.join(' · ') : PHASE_LABEL[pill.priorityStatus] ?? '空闲'
}

export function DynamicIslandConfigBlock(): React.ReactElement {
  const isMac = React.useMemo(() => detectIsMac(), [])
  const [state, setState] = React.useState<DynamicIslandState | null>(null)
  const [enabled, setEnabled] = React.useState(true)
  const [testing, setTesting] = React.useState(false)

  const loadState = React.useCallback(async (): Promise<void> => {
    try {
      const s = await window.electronAPI.getDynamicIslandState()
      setState(s)
      setEnabled(s.enabled)
    } catch (err) {
      console.error('[灵动岛] 读取状态失败:', err)
    }
  }, [])

  React.useEffect(() => {
    void loadState()
  }, [loadState])

  const handleToggleEnabled = async (checked: boolean): Promise<void> => {
    setEnabled(checked)
    try {
      const next = await window.electronAPI.setDynamicIslandEnabled(checked)
      setState(next)
      setEnabled(next.enabled)
      toast.success(checked ? '灵动岛通知已开启' : '灵动岛通知已关闭')
    } catch (err) {
      console.error('[灵动岛] 切换开关失败:', err)
      setEnabled(!checked)
    }
  }

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    try {
      const result = await window.electronAPI.testDynamicIsland()
      if (result.ok) {
        toast.success('已发送测试通知，请查看屏幕顶部')
      } else {
        toast.error(`测试通知发送失败：${result.reason ?? '未知原因'}`)
      }
    } catch (err) {
      toast.error(`测试通知发送失败：${err instanceof Error ? err.message : '未知原因'}`)
    } finally {
      setTesting(false)
      void loadState()
    }
  }

  const formatTime = (ts: number): string => {
    const d = new Date(ts)
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  return (
    <SettingsSection
      title="灵动岛通知"
      description="在 macOS 刘海下方显示 Agent 任务状态、审批提醒与完成通知"
    >
      <SettingsCard>
        {!isMac ? (
          <SettingsRow label="平台支持">
            <span className="text-[13px] text-foreground/40">灵动岛通知目前仅支持 macOS</span>
          </SettingsRow>
        ) : (
          <>
            <SettingsToggle
              label="启用灵动岛通知"
              description="Agent 需要确认、任务完成或失败时在屏幕顶部显示浮层通知"
              checked={enabled}
              onCheckedChange={(checked) => void handleToggleEnabled(checked)}
            />
            <SettingsRow
              label="运行状态"
              description={state?.running ? '渲染进程正在运行' : '渲染进程未运行（首次通知时自动启动）'}
            >
              <span className="text-[13px]">
                {state?.running ? (
                  <span className="text-emerald-500">● 运行中</span>
                ) : (
                  <span className="text-foreground/40">○ 未运行</span>
                )}
              </span>
            </SettingsRow>
            <SettingsRow
              label="当前活动"
              description={describePill(state?.pill)}
            >
              <span className="text-[13px] tabular-nums text-foreground/70">
                {state?.pill ? formatPill(state.pill) : '—'}
              </span>
            </SettingsRow>
            <SettingsRow label="测试通知" description="向灵动岛发送一条测试通知，验证刘海定位与显示效果">
              <Button
                variant="secondary"
                size="sm"
                disabled={!enabled || testing}
                onClick={() => void handleTest()}
              >
                {testing ? '发送中…' : '发送测试通知'}
              </Button>
            </SettingsRow>
          </>
        )}
      </SettingsCard>

      {isMac && state && state.recent.length > 0 && (
        <SettingsCard>
          <div className="flex flex-col gap-1">
            <div className="text-[13px] font-medium text-foreground mb-1">最近会话（最多 5 条）</div>
            {state.recent.slice(0, 5).map((item: DynamicIslandSessionSnapshot) => (
              <div
                key={item.sessionId}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-foreground/[0.03] text-[12px]"
              >
                <span className="text-foreground/40 tabular-nums shrink-0">{formatTime(item.lastActivityAt)}</span>
                <span className="text-foreground/70 truncate flex-1">{item.title}</span>
                <span className="shrink-0 px-1.5 py-0.5 rounded bg-foreground/[0.06] text-foreground/50">
                  {PHASE_LABEL[item.phase] ?? item.phase}
                </span>
                {item.attention && (
                  <span className="shrink-0 size-1.5 rounded-full bg-amber-400" title="需要处理" />
                )}
              </div>
            ))}
          </div>
        </SettingsCard>
      )}
    </SettingsSection>
  )
}
