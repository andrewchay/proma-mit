/**
 * DingTalkSettings - 钉钉集成设置页（多 Bot 版本）
 *
 * 支持多个钉钉 Bot 的配置管理、连接状态、创建引导。
 * 保存配置后自动启动 Stream 连接。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { Loader2, ExternalLink, Power, PowerOff, Plus, Trash2, CheckCircle2, XCircle, Cloud, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { SettingsInput } from './primitives/SettingsInput'
import { SettingsSecretInput } from './primitives/SettingsSecretInput'
import type { AppSettings } from '@/types/settings'
import { dingtalkBotStatesAtom } from '@/atoms/dingtalk-atoms'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import type { DingTalkBotConfig, DingTalkBotBridgeState, DingTalkBridgeStatus, DingTalkTestResult } from '@gravitas/shared'

/** 安全地用系统浏览器打开链接 */
function openLink(url: string): void {
  window.electronAPI.openExternal(url)
}

/** 可点击的外部链接组件 */
function Link({ href, children }: { href: string; children: React.ReactNode }): React.ReactElement {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-primary hover:underline cursor-pointer"
      onClick={() => openLink(href)}
    >
      {children}
      <ExternalLink className="size-3 flex-shrink-0" />
    </button>
  )
}

/** 状态指示器颜色映射 */
const STATUS_CONFIG: Record<DingTalkBridgeStatus, { color: string; label: string }> = {
  disconnected: { color: 'bg-gray-400', label: '未连接' },
  connecting: { color: 'bg-amber-400 animate-pulse', label: '连接中...' },
  connected: { color: 'bg-green-500', label: '已连接' },
  error: { color: 'bg-red-500', label: '连接错误' },
}

// ===== 钉钉 Todo 同步配置段 =====

/**
 * 钉钉 Todo 同步配置：选择已配置的钉钉 Bot 作为项目管理的外部待办同步载体。
 * 凭证仅保存在 Bot 的安全存储中，这里只写 `dingtalkTodo.enabled` + `botId`。
 */
function DingTalkTodoSection(): React.ReactElement {
  const botStates = useAtomValue(dingtalkBotStatesAtom)
  const [settings, setSettings] = React.useState<AppSettings | null>(null)
  const [bots, setBots] = React.useState<DingTalkBotConfig[]>([])
  const [isSaving, setIsSaving] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const [s, config] = await Promise.all([
        window.electronAPI.getSettings(),
        window.electronAPI.getDingTalkMultiConfig(),
      ])
      setSettings(s as AppSettings)
      setBots(config.bots)
    } catch {
      toast.error('加载钉钉 Todo 配置失败')
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  const enabled = settings?.dingtalkTodo?.enabled ?? false
  const botId = settings?.dingtalkTodo?.botId ?? ''
  const selectedBot = bots.find((b) => b.id === botId)
  // 已配置凭证（clientId + clientSecret）的 Bot 才可作为 Todo 载体
  const readyBots = bots.filter((b) => b.clientId && b.clientSecret)

  const handleUpdate = React.useCallback(async (patch: Partial<AppSettings['dingtalkTodo']>) => {
    setIsSaving(true)
    try {
      const next = await window.electronAPI.updateSettings({
        dingtalkTodo: { enabled, botId, ...patch } as NonNullable<AppSettings['dingtalkTodo']>,
      })
      setSettings(next as AppSettings)
    } catch {
      toast.error('保存失败')
    } finally {
      setIsSaving(false)
    }
  }, [enabled, botId])

  return (
    <SettingsSection
      title="钉钉 Todo 同步"
      description="将项目任务同步到钉钉待办，团队成员在钉钉完成后自动反馈到项目管理系统"
    >
      <SettingsCard divided={false}>
        <div className="px-4 py-4 space-y-4">
          {/* 启用开关 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-foreground">启用钉钉 Todo 同步</div>
              <div className="text-xs text-muted-foreground">需要先在本页下方配置一个钉钉 Bot</div>
            </div>
            <Button
              size="sm"
              variant={enabled ? 'default' : 'outline'}
              onClick={() => void handleUpdate({ enabled: !enabled })}
              disabled={isSaving || readyBots.length === 0}
            >
              {isSaving && <Loader2 size={14} className="mr-1 animate-spin" />}
              {enabled ? <><Check size={14} className="mr-1" /> 已启用</> : '启用'}
            </Button>
          </div>

          {/* Bot 选择 */}
          {readyBots.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-[180px_1fr] md:items-center">
              <div className="text-sm font-medium text-foreground">选择钉钉 Bot</div>
              <Select
                value={botId || undefined}
                disabled={!enabled || isSaving}
                onValueChange={(id) => void handleUpdate({ botId: id })}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="选择已配置的钉钉 Bot" />
                </SelectTrigger>
                <SelectContent>
                  {readyBots.map((bot) => {
                    const st = botStates[bot.id]
                    const connected = st?.status === 'connected'
                    return (
                      <SelectItem key={bot.id} value={bot.id}>
                        <span className={cn('flex items-center gap-2')}>
                          {bot.name} · {bot.clientId?.slice(0, 12)}...
                          <span className={`inline-block w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-400'}`} />
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-3 text-xs text-amber-800 dark:text-amber-300">
              <Cloud size={15} className="mt-0.5 flex-shrink-0" />
              <div>暂无可用的钉钉 Bot。请先在下方 Bot 列表填写并保存 Client ID 与 Client Secret。</div>
            </div>
          )}

          {/* 状态提示 */}
          {enabled && selectedBot && (
            <div className="flex items-start gap-2 rounded-lg bg-orange-500/10 px-3 py-3 text-xs text-orange-700 dark:text-orange-300">
              <Cloud size={15} className="mt-0.5 flex-shrink-0" />
              <div>
                已使用「{selectedBot.name}」同步到钉钉待办。回到项目管理「选负责人」即可搜索钉钉通讯录。
              </div>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

// ===== 主组件 =====

export function DingTalkSettings(): React.ReactElement {
  const botStates = useAtomValue(dingtalkBotStatesAtom)
  const [bots, setBots] = React.useState<DingTalkBotConfig[]>([])
  const [loading, setLoading] = React.useState(true)

  const loadBots = React.useCallback(async () => {
    try {
      const config = await window.electronAPI.getDingTalkMultiConfig()
      setBots(config.bots)
    } catch {
      // fallback: 旧 API
      try {
        const oldConfig = await window.electronAPI.getDingTalkConfig()
        if (oldConfig.clientId) {
          setBots([{
            id: 'legacy',
            name: '钉钉助手',
            enabled: oldConfig.enabled,
            clientId: oldConfig.clientId,
            clientSecret: oldConfig.clientSecret,
          }])
        }
      } catch { /* ignore */ }
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { loadBots() }, [loadBots])

  const handleAddBot = React.useCallback(async () => {
    try {
      const saved = await window.electronAPI.saveDingTalkBotConfig({
        name: `钉钉助手 ${bots.length + 1}`,
        enabled: false,
        clientId: '',
        clientSecret: '',
      })
      setBots((prev) => [...prev, saved])
    } catch {
      toast.error('创建 Bot 失败')
    }
  }, [bots.length])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* 钉钉 Todo 同步配置 */}
      <DingTalkTodoSection />

      {/* Bot 列表 */}
      <SettingsSection
        title="钉钉 Bot 列表"
        description="管理多个钉钉机器人，每个 Bot 可绑定不同的工作区和模型"
        action={
          <Button size="sm" variant="outline" onClick={handleAddBot}>
            <Plus size={14} className="mr-1.5" />
            添加 Bot
          </Button>
        }
      >
        {bots.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              还没有配置钉钉 Bot。点击「添加 Bot」开始。
            </div>
          </SettingsCard>
        ) : (
          <div className="space-y-3">
            {bots.map((bot) => (
              <BotConfigCard
                key={bot.id}
                bot={bot}
                state={botStates[bot.id]}
                onSaved={loadBots}
                onRemoved={loadBots}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      {/* 创建钉钉机器人引导 */}
      <SettingsSection
        title="创建钉钉机器人"
        description="按以下步骤在钉钉开放平台创建企业内部应用"
      >
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-5 text-sm">
            {/* 步骤 1 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">1</span>
                <span className="font-medium text-foreground">创建企业内部应用</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                前往{' '}
                <Link href="https://open-dev.dingtalk.com">钉钉开放平台</Link>
                ，点击「创建应用」，选择「企业内部开发」，填写应用信息。
              </p>
            </div>

            {/* 步骤 2 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">2</span>
                <span className="font-medium text-foreground">获取凭证</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                进入应用详情页，在「凭证与基础信息」中找到{' '}
                <span className="text-foreground font-medium">Client ID (AppKey)</span> 和{' '}
                <span className="text-foreground font-medium">Client Secret (AppSecret)</span>，
                复制到上方配置表单中。
              </p>
            </div>

            {/* 步骤 3 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">3</span>
                <span className="font-medium text-foreground">添加机器人能力并保存连接</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                在「应用能力」中启用机器人功能。
                然后回到 Gravitas，<span className="text-foreground font-medium">先点击「保存配置」</span>，
                确认状态变为「已连接」后，再去钉钉后台配置事件订阅（选择 Stream 模式）。
              </p>
            </div>

            {/* 步骤 4 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">4</span>
                <span className="font-medium text-foreground">配置权限并发布</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                在「权限管理」中申请所需权限（消息收发、群组管理等），
                然后发布应用版本，等待企业管理员审批通过。
              </p>
            </div>

            {/* 提示 */}
            <div className="pl-7 p-3 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs">
              <span className="font-medium">重要：</span>配置事件订阅前，必须先在 Gravitas 中保存凭证并确认 Stream 连接成功，
              否则钉钉后台会提示「Stream 模式接入失败」。
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

// ===== 单个 Bot 配置卡片 =====

interface BotConfigCardProps {
  bot: DingTalkBotConfig
  state: DingTalkBotBridgeState | undefined
  onSaved: () => void
  onRemoved: () => void
}

function BotConfigCard({ bot, state, onSaved, onRemoved }: BotConfigCardProps): React.ReactElement {
  const [name, setName] = React.useState(bot.name)
  const [clientId, setClientId] = React.useState(bot.clientId)
  const [clientSecret, setClientSecret] = React.useState('')
  const [trustedSenderIds, setTrustedSenderIds] = React.useState((bot.trustedSenderIds ?? []).join(', '))
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<DingTalkTestResult | null>(null)
  const [expanded, setExpanded] = React.useState(!bot.clientId) // 新建的 Bot 默认展开

  // 加载已有 secret（使用 bot-specific API）
  React.useEffect(() => {
    if (bot.clientSecret && bot.id) {
      window.electronAPI.getDecryptedDingTalkBotSecret?.(bot.id)
        .then((s: string) => { if (s) setClientSecret(s) })
        .catch(() => {
          // 回退到旧 API（兼容迁移前的首个 Bot）
          window.electronAPI.getDecryptedDingTalkSecret?.()
            .then((s: string) => { if (s) setClientSecret(s) })
            .catch(() => {})
        })
    }
  }, [bot.id, bot.clientSecret])

  const statusConfig = state ? STATUS_CONFIG[state.status] : STATUS_CONFIG.disconnected
  const isConnected = state?.status === 'connected' || state?.status === 'connecting'

  const handleSave = React.useCallback(async () => {
    if (!clientId.trim() || !name.trim()) return
    try {
      await window.electronAPI.saveDingTalkBotConfig({
        id: bot.id,
        name: name.trim(),
        enabled: true,
        clientId: clientId.trim(),
        clientSecret: clientSecret || '',
        defaultWorkspaceId: bot.defaultWorkspaceId,
        defaultChannelId: bot.defaultChannelId,
        defaultModelId: bot.defaultModelId,
        trustedSenderIds: trustedSenderIds.split(',').map((id) => id.trim()).filter(Boolean),
      })
      toast.success(`Bot "${name}" 已保存`)
      onSaved()
    } catch {
      toast.error('保存配置失败')
    }
  }, [bot.id, name, clientId, clientSecret, trustedSenderIds, onSaved, bot.defaultWorkspaceId, bot.defaultChannelId, bot.defaultModelId])

  const handleTest = React.useCallback(async () => {
    if (!clientId.trim() || !clientSecret.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.testDingTalkConnection(clientId.trim(), clientSecret.trim())
      setTestResult(result)
    } catch (err) {
      setTestResult({ success: false, message: `测试失败: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setTesting(false)
    }
  }, [clientId, clientSecret])

  const handleToggle = React.useCallback(async () => {
    if (isConnected) {
      await window.electronAPI.stopDingTalkBot(bot.id)
      toast.success(`Bot "${bot.name}" 已停止`)
    } else {
      try {
        await window.electronAPI.startDingTalkBot(bot.id)
        toast.success(`Bot "${bot.name}" 启动中...`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '启动失败')
      }
    }
  }, [bot.id, bot.name, isConnected])

  const handleRemove = React.useCallback(async () => {
    try {
      await window.electronAPI.removeDingTalkBot(bot.id)
      toast.success(`Bot "${bot.name}" 已删除`)
      onRemoved()
    } catch {
      toast.error('删除失败')
    }
  }, [bot.id, bot.name, onRemoved])

  return (
    <SettingsCard>
      {/* 头部：名称 + 状态 + 展开/折叠 */}
      <button
        type="button"
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusConfig.color}`} />
          <span className="font-medium text-sm">{bot.name || '未命名 Bot'}</span>
          <span className="text-xs text-muted-foreground">{bot.clientId ? bot.clientId.slice(0, 12) + '...' : '未配置'}</span>
        </div>
        <div className="flex items-center gap-2">
          {isConnected ? (
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); handleToggle() }}>
              <PowerOff size={14} className="mr-1" />
              停止
            </Button>
          ) : bot.clientId ? (
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); handleToggle() }}
              disabled={state?.status === 'connecting'}>
              {state?.status === 'connecting' ? <Loader2 size={14} className="animate-spin mr-1" /> : <Power size={14} className="mr-1" />}
              启动
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">{expanded ? '▾' : '▸'}</span>
        </div>
      </button>

      {/* 展开的配置表单 */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
          <SettingsInput
            label="Bot 名称"
            value={name}
            onChange={setName}
            placeholder="如：研发助手"
          />
          <SettingsInput
            label="Client ID (AppKey)"
            value={clientId}
            onChange={setClientId}
            placeholder="dingxxxxxxxx"
          />
          <SettingsSecretInput
            label="Client Secret (AppSecret)"
            value={clientSecret}
            onChange={setClientSecret}
            placeholder="输入 Client Secret"
          />
          <SettingsInput
            label="可信发送者 userId（可选，逗号分隔）"
            value={trustedSenderIds}
            onChange={setTrustedSenderIds}
            placeholder="manager123, user456"
          />
          <p className="text-xs text-amber-700 dark:text-amber-400">
            未列入白名单的消息始终以只读安全模式运行；白名单发送者可执行完整 Agent 操作。
          </p>

          <div className="flex items-center gap-3">
            <Button size="sm" variant="outline" onClick={handleTest}
              disabled={testing || !clientId.trim() || !clientSecret.trim()}>
              {testing && <Loader2 size={14} className="animate-spin" />}
              <span>{testing ? '测试中...' : '测试连接'}</span>
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!clientId.trim() || !name.trim()}>
              保存配置
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="destructive">
                  <Trash2 size={14} className="mr-1" />
                  删除
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认删除</AlertDialogTitle>
                  <AlertDialogDescription>
                    删除 Bot &quot;{bot.name}&quot; 将同时断开连接。此操作不可撤销。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={handleRemove}>删除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          {testResult && (
            <div className={cn(
              'p-3 rounded-lg flex items-start gap-2 text-sm',
              testResult.success ? 'bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-red-500/10 text-red-700 dark:text-red-400'
            )}>
              {testResult.success
                ? <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
                : <XCircle size={16} className="flex-shrink-0 mt-0.5" />
              }
              <span>{testResult.message}</span>
            </div>
          )}

          {state?.status === 'error' && state.errorMessage && (
            <div className="p-2.5 rounded-lg bg-red-500/10 text-red-700 dark:text-red-400 text-sm">
              {state.errorMessage}
            </div>
          )}
        </div>
      )}
    </SettingsCard>
  )
}
