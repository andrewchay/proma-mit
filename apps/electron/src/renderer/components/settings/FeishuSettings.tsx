/**
 * FeishuSettings - 飞书集成设置页
 *
 * 双 Tab 布局：
 * - Bot 配置：飞书应用凭证、连接状态、默认配置、创建引导、命令说明
 * - 绑定管理：查看/管理所有活跃的飞书聊天绑定（群聊/单聊的工作区/会话分配）
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Loader2, CheckCircle2, XCircle, ExternalLink, Users, User, Trash2, RefreshCw, Copy, Check, Power, PowerOff, Plus, ChevronRight, Cloud, QrCode, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { SettingsInput } from './primitives/SettingsInput'
import { SettingsSecretInput } from './primitives/SettingsSecretInput'
import { SettingsRow } from './primitives/SettingsRow'
import { feishuBotStatesAtom, feishuBindingsAtom } from '@/atoms/feishu-atoms'
import { agentWorkspacesAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import type { AppSettings } from '@/types/settings'
import { cn } from '@/lib/utils'
import type { FeishuTestResult, FeishuChatBinding, FeishuBotConfig, FeishuBotBridgeState, FeishuRegisterAppQRCode, FeishuRegisterAppStatus } from '@proma/shared'

// ===== 常量 =====

type FeishuTab = 'config' | 'bindings'

const TAB_OPTIONS: Array<{ value: FeishuTab; label: string }> = [
  { value: 'config', label: 'Bot 配置' },
  { value: 'bindings', label: '绑定管理' },
]

/** 连接状态颜色映射 */
const STATUS_CONFIG = {
  disconnected: { color: 'bg-gray-400', label: '未连接' },
  connecting: { color: 'bg-amber-400 animate-pulse', label: '连接中...' },
  connected: { color: 'bg-green-500', label: '已连接' },
  error: { color: 'bg-red-500', label: '连接错误' },
} as const


/** 飞书批量权限配置 JSON（用于一键复制粘贴到飞书开放平台） */
const FEISHU_SCOPES_JSON = JSON.stringify({
  scopes: {
    tenant: [
      'contact:contact.base:readonly',
      'im:chat:readonly',
      'im:chat.members:read',
      'im:message',
      'im:message.group_at_msg:readonly',
      'im:message.group_msg',
      'im:message.p2p_msg:readonly',
      'im:message:send_as_bot',
      'im:resource',
    ],
    user: [],
  },
}, null, 2)

// ===== 工具组件 =====

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

// ===== 权限配置步骤组件 =====

/** 权限列表展示 + 一键复制批量权限 JSON */
function PermissionsStep(): React.ReactElement {
  const [copied, setCopied] = React.useState(false)
  const [expanded, setExpanded] = React.useState(false)

  const handleCopy = React.useCallback(() => {
    navigator.clipboard.writeText(FEISHU_SCOPES_JSON).then(() => {
      setCopied(true)
      toast.success('权限配置已复制到剪贴板')
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {
      toast.error('复制失败')
    })
  }, [])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">4</span>
        <span className="font-medium text-foreground">配置权限</span>
      </div>
      <div className="pl-7 space-y-2 text-muted-foreground">
        <p>
          进入「权限管理」页面，点击下方按钮复制权限配置 JSON，
          然后在飞书开放平台通过「批量开通」粘贴即可一键添加所有权限：
        </p>
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRight size={14} className={cn('transition-transform duration-200', expanded && 'rotate-90')} />
          <span>{expanded ? '收起权限详情' : '展开查看权限详情'}</span>
        </button>
        {expanded && (
          <div className="bg-muted/50 rounded-md p-3 font-mono text-xs space-y-0.5 animate-in fade-in-0 slide-in-from-top-1 duration-200">
            <div><span className="text-foreground/70">im:message</span> — 获取与发送单聊、群组消息</div>
            <div><span className="text-foreground/70">im:message:send_as_bot</span> — 以机器人身份发送消息</div>
            <div><span className="text-foreground/70">im:message.p2p_msg:readonly</span> — 接收用户发给机器人的单聊消息</div>
            <div><span className="text-foreground/70">im:message.group_at_msg:readonly</span> — 接收群聊中 @机器人 的消息</div>
            <div><span className="text-foreground/70">im:message.group_msg</span> — 读取群聊历史消息（群聊上下文）</div>
            <div><span className="text-foreground/70">im:chat:readonly</span> — 获取群组信息</div>
            <div><span className="text-foreground/70">im:chat.members:read</span> — 获取群成员列表（支持 @某人）</div>
            <div><span className="text-foreground/70">im:resource</span> — 获取消息中的资源文件（图片、文档等）</div>
            <div><span className="text-foreground/70">contact:contact.base:readonly</span> — 获取用户基本信息（群聊发送者名称）</div>
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={handleCopy}
          className="gap-1.5"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{copied ? '已复制' : '复制批量权限配置'}</span>
        </Button>
      </div>
    </div>
  )
}

// ===== 飞书 CLI 预置 Prompt =====

const FEISHU_CLI_PROMPT = `请帮我配置飞书 CLI 开发环境，按以下步骤执行：

1. 安装飞书 CLI 到全局
npm install -g @larksuite/cli

2. 将 SKILL 配置到本工作区（默认配置本工作区，但请提醒用户是否需要额外安装到全局，会使得预置上下文增加，造成不必要的Token消耗）
npx skills add https://github.com/larksuite/cli -y -g

3. 初始化 CLI 配置
lark-cli config init --new

到最后一步配置环节需要特别提醒用户：已有Bot应用则选择已有应用，没有再选择新建飞书CLI应用。`

/** 飞书 CLI 配置引导 */
function FeishuCliSection(): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const handleSendToAgent = React.useCallback(() => {
    navigator.clipboard.writeText(FEISHU_CLI_PROMPT).then(() => {
      setCopied(true)
      toast.success('配置指令已复制，请在 Agent 对话中粘贴发送')
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {
      toast.error('复制失败')
    })
  }, [])

  return (
    <SettingsSection
      title="配置飞书 CLI"
      description="飞书官方开源的命令行工具，配置后 Proma Agent 将可以直接读消息、查日历、写文档、建多维表格、发邮件，把任务真正落到飞书里完成。"
    >
      <SettingsCard divided={false}>
        <div className="px-4 py-4 space-y-2 text-sm text-muted-foreground">
          <p className="text-xs">复制配置提示词，并前往飞书Bot日常绑定的<strong>工作区</strong>，创建新的 Proma Agent 对话并发送即可让 Proma 协助完成配置。</p>
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronRight size={14} className={cn('transition-transform duration-200', expanded && 'rotate-90')} />
            <span>{expanded ? '收起配置步骤' : '展开查看配置步骤'}</span>
          </button>

          {expanded && (
            <div className="bg-muted/50 rounded-md p-3 font-mono text-xs space-y-1.5 animate-in fade-in-0 slide-in-from-top-1 duration-200">
              <div><span className="text-foreground/70 font-semibold">步骤 1</span> — 安装飞书 CLI 到全局</div>
              <div className="pl-3 text-foreground/60">npm install -g @larksuite/cli</div>
              <div className="pt-1"><span className="text-foreground/70 font-semibold">步骤 2</span> — 将 SKILL 配置到本工作区（默认配置本工作区，但请提醒用户是否需要额外安装到全局，会使得预置上下文增加，造成不必要的Token消耗）</div>
              <div className="pl-3 text-foreground/60">npx skills add https://github.com/larksuite/cli -y -g</div>
              <div className="pt-1"><span className="text-foreground/70 font-semibold">步骤 3</span> — 初始化 CLI 配置</div>
              <div className="pl-3 text-foreground/60">lark-cli config init --new</div>
            </div>
          )}

          <Button
            size="sm"
            variant="outline"
            onClick={handleSendToAgent}
            className="gap-1.5"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied ? '已复制至剪贴板' : '复制配置提示词'}</span>
          </Button>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

// ===== 绑定卡片组件 =====

interface FeishuBindingCardProps {
  binding: FeishuChatBinding
  onUpdate: (chatId: string, updates: { workspaceId?: string; sessionId?: string }) => void
  onRemove: (chatId: string) => void
}

function FeishuBindingCard({ binding, onUpdate, onRemove }: FeishuBindingCardProps): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const sessions = useAtomValue(agentSessionsAtom)

  const isGroup = binding.chatType === 'group'
  const displayName = isGroup ? (binding.groupName ?? '未知群组') : '单聊'

  // 当前绑定工作区下的会话列表
  const workspaceSessions = React.useMemo(
    () => sessions.filter((s) => s.workspaceId === binding.workspaceId),
    [sessions, binding.workspaceId]
  )

  const currentWorkspace = workspaces.find((w) => w.id === binding.workspaceId)
  const currentSession = sessions.find((s) => s.id === binding.sessionId)

  return (
    <div className="px-4 py-3 space-y-3">
      {/* 头部：类型图标 + 名称 + 删除 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={cn(
            'flex items-center justify-center w-8 h-8 rounded-lg',
            isGroup ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'bg-green-500/10 text-green-600 dark:text-green-400'
          )}>
            {isGroup ? <Users size={16} /> : <User size={16} />}
          </div>
          <div>
            <div className="text-sm font-medium text-foreground">{displayName}</div>
            <div className="text-xs text-muted-foreground">
              {isGroup ? '群聊' : '私聊'} · {new Date(binding.createdAt).toLocaleDateString('zh-CN')}
            </div>
          </div>
        </div>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive">
              <Trash2 size={14} />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>解除绑定</AlertDialogTitle>
              <AlertDialogDescription>
                确定要解除「{displayName}」的飞书聊天绑定吗？解除后下次在飞书发消息会自动创建新绑定。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={() => onRemove(binding.chatId)}>
                确认解除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* 工作区选择 */}
      <div className="grid grid-cols-[80px_1fr] gap-2 items-center text-sm">
        <span className="text-muted-foreground">工作区</span>
        <Select
          value={binding.workspaceId}
          onValueChange={(value) => onUpdate(binding.chatId, { workspaceId: value })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="选择工作区">
              {currentWorkspace?.name ?? '未知工作区'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* 会话显示 */}
        <span className="text-muted-foreground">会话</span>
        <Select
          value={binding.sessionId}
          onValueChange={(value) => onUpdate(binding.chatId, { sessionId: value })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="选择会话">
              {currentSession?.title ?? binding.sessionId.slice(0, 8)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {workspaceSessions.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

// ===== 绑定管理 Tab =====

function FeishuBindingsTab(): React.ReactElement {
  const bindings = useAtomValue(feishuBindingsAtom)
  const setBindings = useSetAtom(feishuBindingsAtom)
  const botStates = useAtomValue(feishuBotStatesAtom)
  const [refreshing, setRefreshing] = React.useState(false)

  const anyConnected = Object.values(botStates).some((b) => b.status === 'connected')

  // 刷新绑定列表
  const refreshBindings = React.useCallback(async () => {
    setRefreshing(true)
    try {
      const list = await window.electronAPI.listFeishuBindings()
      setBindings(list)
    } catch {
      toast.error('获取绑定列表失败')
    } finally {
      setRefreshing(false)
    }
  }, [setBindings])

  // 进入 Tab 时自动刷新
  React.useEffect(() => {
    refreshBindings()
  }, [refreshBindings])

  // 有 Bot 连接时刷新
  React.useEffect(() => {
    if (anyConnected) {
      refreshBindings()
    }
  }, [anyConnected, refreshBindings])

  // 更新绑定
  const handleUpdate = React.useCallback(async (chatId: string, updates: { workspaceId?: string; sessionId?: string }) => {
    try {
      const result = await window.electronAPI.updateFeishuBinding({ chatId, ...updates })
      if (result) {
        setBindings((prev) => prev.map((b) => b.chatId === chatId ? result : b))
        toast.success('绑定已更新')
      }
    } catch {
      toast.error('更新绑定失败')
    }
  }, [setBindings])

  // 移除绑定
  const handleRemove = React.useCallback(async (chatId: string) => {
    try {
      const ok = await window.electronAPI.removeFeishuBinding(chatId)
      if (ok) {
        setBindings((prev) => prev.filter((b) => b.chatId !== chatId))
        toast.success('绑定已解除')
      }
    } catch {
      toast.error('解除绑定失败')
    }
  }, [setBindings])

  // 按类型分组：群聊 + 单聊
  const groupBindings = bindings.filter((b) => b.chatType === 'group')
  const p2pBindings = bindings.filter((b) => b.chatType !== 'group')

  return (
    <div className="space-y-8">
      <SettingsSection
        title="绑定管理"
        description="查看和管理飞书聊天与 Proma 工作区/会话的绑定关系"
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={refreshBindings}
            disabled={refreshing}
          >
            <RefreshCw size={14} className={cn(refreshing && 'animate-spin')} />
            <span className="ml-1.5">刷新</span>
          </Button>
        }
      >
        {bindings.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              暂无活跃绑定。启动 Bridge 后在飞书中发消息即可自动创建绑定。
            </div>
          </SettingsCard>
        ) : (
          <div className="space-y-4">
            {/* 群聊绑定 */}
            {groupBindings.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  群聊 ({groupBindings.length})
                </div>
                <SettingsCard>
                  {groupBindings.map((binding) => (
                    <FeishuBindingCard
                      key={binding.chatId}
                      binding={binding}
                      onUpdate={handleUpdate}
                      onRemove={handleRemove}
                    />
                  ))}
                </SettingsCard>
              </div>
            )}

            {/* 单聊绑定 */}
            {p2pBindings.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  单聊 ({p2pBindings.length})
                </div>
                <SettingsCard>
                  {p2pBindings.map((binding) => (
                    <FeishuBindingCard
                      key={binding.chatId}
                      binding={binding}
                      onUpdate={handleUpdate}
                      onRemove={handleRemove}
                    />
                  ))}
                </SettingsCard>
              </div>
            )}
          </div>
        )}
      </SettingsSection>
    </div>
  )
}

// ===== 单个 Bot 配置卡片 =====

interface BotConfigCardProps {
  bot: FeishuBotConfig
  state: FeishuBotBridgeState | undefined
  onSaved: () => void
  onRemoved: () => void
}

function BotConfigCard({ bot, state, onSaved, onRemoved }: BotConfigCardProps): React.ReactElement {
  const setBotStates = useSetAtom(feishuBotStatesAtom)
  const [name, setName] = React.useState(bot.name)
  const [appId, setAppId] = React.useState(bot.appId)
  const [appSecret, setAppSecret] = React.useState('')
  const [trustedSenderIds, setTrustedSenderIds] = React.useState((bot.trustedSenderIds ?? []).join(', '))
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<FeishuTestResult | null>(null)
  const [expanded, setExpanded] = React.useState(!bot.appId) // 新建的 Bot 默认展开

  // 加载已有 secret（使用 bot-specific API）
  React.useEffect(() => {
    if (bot.appSecret && bot.id) {
      window.electronAPI.getDecryptedFeishuBotSecret?.(bot.id)
        .then((s: string) => { if (s) setAppSecret(s) })
        .catch(() => {
          // 回退到旧 API（兼容迁移前的首个 Bot）
          window.electronAPI.getDecryptedFeishuSecret?.()
            .then((s: string) => { if (s) setAppSecret(s) })
            .catch(() => {})
        })
    }
  }, [bot.id, bot.appSecret])

  const statusConfig = state ? STATUS_CONFIG[state.status] : STATUS_CONFIG.disconnected
  const isConnected = state?.status === 'connected' || state?.status === 'connecting'

  const handleSave = React.useCallback(async () => {
    if (!appId.trim() || !name.trim()) return
    try {
      await window.electronAPI.saveFeishuBotConfig({
        id: bot.id,
        name: name.trim(),
        enabled: true,
        appId: appId.trim(),
        appSecret: appSecret || '',
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
  }, [bot.id, name, appId, appSecret, trustedSenderIds, onSaved, bot.defaultWorkspaceId, bot.defaultModelId, bot.defaultChannelId])

  const handleTest = React.useCallback(async () => {
    if (!appId.trim() || !appSecret.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.testFeishuConnection(appId.trim(), appSecret.trim())
      setTestResult(result)
    } catch (err) {
      setTestResult({ success: false, message: `测试失败: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setTesting(false)
    }
  }, [appId, appSecret])

  /** 操作完成后主动拉取最新状态，确保 UI 同步 */
  const refreshBotStates = React.useCallback(async () => {
    try {
      const multiState = await window.electronAPI.getFeishuMultiStatus?.()
      if (multiState?.bots) {
        setBotStates(multiState.bots)
      }
    } catch { /* 忽略 */ }
  }, [setBotStates])

  const handleToggle = React.useCallback(async () => {
    if (isConnected) {
      await window.electronAPI.stopFeishuBot(bot.id)
      toast.success(`Bot "${bot.name}" 已停止`)
      await refreshBotStates()
    } else {
      // 启动是异步的（10-15秒），不阻塞等待完成
      // 先发起启动请求，然后轮询状态直到连接成功或失败
      window.electronAPI.startFeishuBot(bot.id).catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : '启动失败')
        refreshBotStates()
      })
      // 短暂等待让主进程设置 connecting 状态
      await new Promise((r) => setTimeout(r, 300))
      await refreshBotStates()
      // 轮询直到状态不再是 connecting
      const poll = setInterval(async () => {
        try {
          const multiState = await window.electronAPI.getFeishuMultiStatus?.()
          if (multiState?.bots) {
            setBotStates(multiState.bots)
            const botState = multiState.bots[bot.id]
            if (!botState || botState.status !== 'connecting') {
              clearInterval(poll)
              if (botState?.status === 'connected') {
                toast.success(`Bot "${bot.name}" 已连接`)
              }
            }
          }
        } catch {
          clearInterval(poll)
        }
      }, 1000)
      // 安全超时：60秒后停止轮询
      setTimeout(() => clearInterval(poll), 60_000)
    }
  }, [bot.id, bot.name, isConnected, refreshBotStates, setBotStates])

  const handleRemove = React.useCallback(async () => {
    try {
      await window.electronAPI.removeFeishuBot(bot.id)
      toast.success(`Bot "${bot.name}" 已删除`)
      onRemoved()
    } catch {
      toast.error('删除失败')
    }
  }, [bot.id, bot.name, onRemoved])

  return (
    <SettingsCard>
      {/* 头部：名称 + 状态 + 展开/折叠 */}
      <div
        role="button"
        tabIndex={0}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/30 transition-colors cursor-pointer"
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded) } }}
      >
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusConfig.color}`} />
          <span className="font-medium text-sm">{bot.name || '未命名 Bot'}</span>
          <span className="text-xs text-muted-foreground">{bot.appId ? bot.appId.slice(0, 12) + '...' : '未配置'}</span>
        </div>
        <div className="flex items-center gap-2">
          {isConnected ? (
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); handleToggle() }}>
              <PowerOff size={14} className="mr-1" />
              停止
            </Button>
          ) : bot.appId ? (
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); handleToggle() }}
              disabled={state?.status === 'connecting'}>
              {state?.status === 'connecting' ? <Loader2 size={14} className="animate-spin mr-1" /> : <Power size={14} className="mr-1" />}
              启动
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

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
            label="App ID"
            value={appId}
            onChange={setAppId}
            placeholder="cli_xxxxxxxxxx"
          />
          <SettingsSecretInput
            label="App Secret"
            value={appSecret}
            onChange={setAppSecret}
            placeholder="输入 App Secret"
          />
          <SettingsInput
            label="可信发送者 open_id（可选，逗号分隔）"
            value={trustedSenderIds}
            onChange={setTrustedSenderIds}
            placeholder="ou_xxx, ou_yyy"
          />
          <p className="text-xs text-amber-700 dark:text-amber-400">
            未列入白名单的消息始终以只读安全模式运行；白名单发送者可执行完整 Agent 操作。
          </p>

          <div className="flex items-center gap-3">
            <Button size="sm" variant="outline" onClick={handleTest}
              disabled={testing || !appId.trim() || !appSecret.trim()}>
              {testing && <Loader2 size={14} className="animate-spin" />}
              <span>{testing ? '测试中...' : '测试连接'}</span>
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!appId.trim() || !name.trim()}>
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
                    删除 Bot "{bot.name}" 将同时断开连接并清除所有绑定。此操作不可撤销。
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
              <span>{testResult.message}{testResult.botName && ` — ${testResult.botName}`}</span>
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

// ===== 飞书 Todo 同步配置段 =====

/**
 * 飞书 Todo 同步配置：选择已配置的飞书 Bot 作为项目管理的外部待办同步载体。
 * 凭证仅保存在 Bot 的安全存储中，这里只写 `feishuTodo.enabled` + `botId`。
 */
function FeishuTodoSection(): React.ReactElement {
  const botStates = useAtomValue(feishuBotStatesAtom)
  const [settings, setSettings] = React.useState<AppSettings | null>(null)
  const [bots, setBots] = React.useState<FeishuBotConfig[]>([])
  const [isSaving, setIsSaving] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const [s, config] = await Promise.all([
        window.electronAPI.getSettings(),
        window.electronAPI.getFeishuMultiConfig(),
      ])
      setSettings(s as AppSettings)
      setBots(config.bots)
    } catch {
      toast.error('加载飞书 Todo 配置失败')
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  const enabled = settings?.feishuTodo?.enabled ?? false
  const botId = settings?.feishuTodo?.botId ?? ''
  const selectedBot = bots.find((b) => b.id === botId)
  // 已配置凭证（appId）的 Bot 才可作为 Todo 载体
  const readyBots = bots.filter((b) => b.appId)

  const handleUpdate = React.useCallback(async (patch: Partial<NonNullable<AppSettings['feishuTodo']>>) => {
    setIsSaving(true)
    try {
      const next = await window.electronAPI.updateSettings({
        feishuTodo: { enabled, botId, ...patch } as NonNullable<AppSettings['feishuTodo']>,
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
      title="飞书 Todo 同步"
      description="将项目任务同步到飞书任务（Todo），成员在飞书完成后自动反馈到项目管理系统"
    >
      <SettingsCard divided={false}>
        <div className="px-4 py-4 space-y-4">
          {/* 启用开关 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-foreground">启用飞书 Todo 同步</div>
              <div className="text-xs text-muted-foreground">需要先在本页下方配置一个飞书 Bot</div>
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
              <div className="text-sm font-medium text-foreground">选择飞书 Bot</div>
              <Select
                value={botId || undefined}
                disabled={!enabled || isSaving}
                onValueChange={(id) => void handleUpdate({ botId: id })}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="选择已配置的飞书 Bot" />
                </SelectTrigger>
                <SelectContent>
                  {readyBots.map((bot) => {
                    const st = botStates[bot.id]
                    const connected = st?.status === 'connected'
                    return (
                      <SelectItem key={bot.id} value={bot.id}>
                        <span className={cn('flex items-center gap-2')}>
                          {bot.name}
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
              <div>暂无可用的飞书 Bot。请先在下方 Bot 列表填写并保存 App ID 与 App Secret。</div>
            </div>
          )}

          {/* 状态提示 */}
          {enabled && selectedBot && (
            <div className="flex items-start gap-2 rounded-lg bg-blue-500/10 px-3 py-3 text-xs text-blue-700 dark:text-blue-300">
              <Cloud size={15} className="mt-0.5 flex-shrink-0" />
              <div>
                已使用「{selectedBot.name}」同步到飞书 Todo。回到项目管理「选负责人」即可搜索飞书通讯录。
              </div>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

// ===== 飞书扫码创建（注册）机器人 Dialog =====

type ScanPhase = 'loading' | 'qrcode' | 'error' | 'success'

/**
 * 用飞书官方 registerApp 接口生成二维码，用户扫码后自动创建 PersonalAgent 应用，
 * 成功后保存凭证并启动 Bot。全程无需手工复制 App ID / Secret。
 */
function FeishuScanRegisterDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
}): React.ReactElement | null {
  const [phase, setPhase] = React.useState<ScanPhase>('loading')
  const [qr, setQr] = React.useState<FeishuRegisterAppQRCode | null>(null)
  const [status, setStatus] = React.useState<FeishuRegisterAppStatus['status'] | ''>('')
  const [error, setError] = React.useState('')
  const startedRef = React.useRef(false)

  // 订阅主进程推送的二维码与状态
  React.useEffect(() => {
    if (!open) return undefined
    const offQr = window.electronAPI.onFeishuRegisterQrCode?.((next) => {
      setQr(next)
      setPhase(next.dataUrl ? 'qrcode' : 'qrcode')
      setError('')
    })
    const offStatus = window.electronAPI.onFeishuRegisterStatus?.((s) => {
      setStatus(s.status)
    })
    return () => {
      offQr?.()
      offStatus?.()
    }
  }, [open])

  // 打开时启动注册流程
  React.useEffect(() => {
    if (!open || startedRef.current) return
    startedRef.current = true
    setPhase('loading')
    setQr(null)
    setStatus('')
    setError('')
    window.electronAPI.startFeishuRegistration()
      .then((result) => {
        // 注册成功：自动保存为 Bot 并启动
        return window.electronAPI.saveFeishuBotConfig({
          name: '飞书扫码创建',
          enabled: true,
          appId: result.appId,
          appSecret: result.appSecret,
        }).then(() => {
          setPhase('success')
          toast.success('飞书 Bot 已创建并接入')
          onCreated()
          // 成功后自动关闭弹窗
          setTimeout(() => onClose(), 1200)
        })
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('aborted') || message.includes('AbortError') || message.includes('cancel')) {
          return // 用户主动取消，不报错
        }
        setPhase('error')
        setError(message)
      })
  }, [open, onClose, onCreated])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[420px] max-w-[92vw] rounded-2xl bg-card border p-6 shadow-xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <QrCode size={18} className="text-primary" />
          <h3 className="text-base font-medium">扫码创建飞书 Bot</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          飞书将自动创建一个 PersonalAgent 应用，扫码完成后自动保存凭证并接入，无需手动复制 App ID / Secret。
        </p>

        <div className="flex flex-col items-center gap-3 py-2">
          {phase === 'loading' && (
            <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 size={22} className="animate-spin" />
              <span>正在生成二维码…</span>
            </div>
          )}

          {phase === 'qrcode' && qr && (
            <>
              <div className="rounded-xl border p-3 bg-white">
                {qr.dataUrl ? (
                  <img src={qr.dataUrl} alt="飞书扫码注册二维码" className="w-[260px] h-[260px]" />
                ) : (
                  <div className="w-[260px] h-[260px] flex flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground px-4">
                    <QrCode size={32} />
                    <span>二维码生成失败，请在浏览器中打开下方链接</span>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                onClick={() => window.electronAPI.openExternal(qr.url)}
              >
                <ExternalLink size={12} />
                在浏览器中打开注册页
              </button>
            </>
          )}

          {phase === 'error' && (
            <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-3 text-sm text-red-600 w-full">
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <div className="font-medium">注册失败</div>
                <div className="break-words text-xs">{error}</div>
              </div>
            </div>
          )}

          {phase === 'success' && (
            <div className="flex flex-col items-center gap-2 py-8 text-sm text-green-600">
              <CheckCircle2 size={24} />
              <span>创建成功，正在关闭…</span>
            </div>
          )}
        </div>

        {status && phase === 'qrcode' && (
          <div className="text-center text-xs text-muted-foreground">
            {status === 'slow_down' ? '请求过于频繁，稍作等待…' : status === 'domain_switched' ? '已切换域名…' : '等待扫码确认…'}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={() => { void window.electronAPI.cancelFeishuRegistration?.(); onClose() }}>
            取消
          </Button>
        </div>
      </div>
    </div>
  )
}

// ===== Bot 配置 Tab（多 Bot 版本）=====

function FeishuConfigTab(): React.ReactElement {
  const botStates = useAtomValue(feishuBotStatesAtom)
  const setBotStates = useSetAtom(feishuBotStatesAtom)
  const [bots, setBots] = React.useState<FeishuBotConfig[]>([])
  const [loading, setLoading] = React.useState(true)
  const [scanOpen, setScanOpen] = React.useState(false)

  const loadBots = React.useCallback(async () => {
    try {
      const config = await window.electronAPI.getFeishuMultiConfig()
      setBots(config.bots)
    } catch {
      // fallback: 旧 API
      try {
        const oldConfig = await window.electronAPI.getFeishuConfig()
        if (oldConfig.appId) {
          setBots([{
            id: 'legacy',
            name: '飞书助手',
            enabled: oldConfig.enabled,
            appId: oldConfig.appId,
            appSecret: oldConfig.appSecret,
          }])
        }
      } catch { /* ignore */ }
    } finally {
      setLoading(false)
    }
  }, [])

  // 进入 Tab 时同步最新状态，避免因启动时序问题导致颜色显示错误
  const refreshStates = React.useCallback(async () => {
    try {
      const multiState = await window.electronAPI.getFeishuMultiStatus?.()
      if (multiState?.bots) {
        setBotStates(multiState.bots)
      }
    } catch { /* 忽略 */ }
  }, [setBotStates])

  React.useEffect(() => {
    loadBots()
    refreshStates()
  }, [loadBots, refreshStates])

  const handleAddBot = React.useCallback(async () => {
    try {
      const saved = await window.electronAPI.saveFeishuBotConfig({
        name: `飞书助手 ${bots.length + 1}`,
        enabled: false,
        appId: '',
        appSecret: '',
        defaultWorkspaceId: undefined,
        defaultChannelId: undefined,
        defaultModelId: undefined,
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
      {/* 飞书 Todo 同步配置 */}
      <FeishuTodoSection />

      {/* Bot 列表 */}
      <SettingsSection
        title="飞书 Bot 列表"
        description="管理多个飞书机器人，每个 Bot 可绑定不同的工作区和模型"
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="default" onClick={() => setScanOpen(true)}>
              <QrCode size={14} className="mr-1.5" />
              扫码创建
            </Button>
            <Button size="sm" variant="outline" onClick={handleAddBot}>
              <Plus size={14} className="mr-1.5" />
              添加 Bot
            </Button>
          </div>
        }
      >
        {bots.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              还没有配置飞书 Bot。点击「扫码创建」一键接入，或「添加 Bot」手动填写 App ID / Secret。
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

      {/* 创建飞书 Bot 引导 */}
      <SettingsSection
        title="创建飞书 Bot"
        description="首次使用？按以下步骤在飞书开放平台创建机器人应用"
      >
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-5 text-sm">
            {/* 步骤 1 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">1</span>
                <span className="font-medium text-foreground">创建自建应用</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                前往{' '}
                <Link href="https://open.feishu.cn/app">飞书开放平台</Link>
                {' '}（海外版：
                <Link href="https://open.larksuite.com/app">Lark 开放平台</Link>
                ），点击「创建自建应用」并填写名称描述。
              </p>
            </div>

            {/* 步骤 2 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">2</span>
                <span className="font-medium text-foreground">获取凭证</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                进入详情页，在「凭证与基础信息」中找到{' '}
                <span className="text-foreground font-medium">App ID</span> 和{' '}
                <span className="text-foreground font-medium">App Secret</span>，
                复制到上方的配置表单。
              </p>
            </div>

            {/* 步骤 3 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">3</span>
                <span className="font-medium text-foreground">启用机器人能力</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                进入「添加应用能力」页面，启用「机器人」能力。
                这样应用才能接收和发送飞书消息。
              </p>
            </div>

            {/* 步骤 4 */}
            <PermissionsStep />

            {/* 步骤 5 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">5</span>
                <span className="font-medium text-foreground">配置事件订阅（关键步骤）</span>
              </div>
              <div className="pl-7 space-y-1.5 text-muted-foreground">
                <p>
                  进入「事件与回调」页面：
                </p>
                <ol className="list-decimal pl-4 space-y-1">
                  <li>
                    事件订阅方式选择{' '}
                    <span className="text-foreground font-medium">「使用长连接接收事件」</span>
                    （而非 Webhook，无需公网 IP）
                  </li>
                  <li>
                    添加事件{' '}
                    <code className="bg-muted/50 px-1.5 py-0.5 rounded text-xs text-foreground/80">im.message.receive_v1</code>
                    {' '}（接收消息）
                  </li>
                </ol>
              </div>
            </div>

            {/* 步骤 6 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">6</span>
                <span className="font-medium text-foreground">发布应用</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                进入「版本管理与发布」→ 创建版本 → 提交审核。
                需要企业管理员在{' '}
                <Link href="https://feishu.cn/admin">管理后台</Link>
                {' '}审核通过后，机器人才能正常使用。
              </p>
            </div>

            {/* 提示 */}
            <div className="pl-7 p-3 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs">
              版本审核通过并发布后，在飞书中搜索机器人名称添加到聊天，
              即可通过飞书向 Proma Agent 发送指令。
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* 飞书 CLI 配置引导 */}
      <FeishuCliSection />

      {/* 扫码创建弹窗 */}
      <FeishuScanRegisterDialog
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onCreated={loadBots}
      />

    </div>
  )
}

// ===== 主组件 =====

export function FeishuSettings(): React.ReactElement {
  const [activeTab, setActiveTab] = React.useState<FeishuTab>('config')

  return (
    <div className="space-y-6">
      {/* Tab 切换栏 */}
      <div className="inline-flex rounded-lg bg-muted p-1 gap-0.5">
        {TAB_OPTIONS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setActiveTab(tab.value)}
            className={cn(
              'px-4 py-1.5 rounded-md text-sm font-medium transition-colors',
              activeTab === tab.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab 内容 */}
      {activeTab === 'config' ? <FeishuConfigTab /> : <FeishuBindingsTab />}
    </div>
  )
}
