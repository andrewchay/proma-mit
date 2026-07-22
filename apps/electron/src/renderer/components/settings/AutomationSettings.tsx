/** AI SDK 与设备自动化的运行诊断和安全控制。 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { CircleAlert, CircleCheck, LoaderCircle, MonitorCog, RefreshCw, ShieldAlert, Square, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { AGENT_PROVIDER_RUNTIME_CAPABILITIES, getAgentCompatibleProviders } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { settingsTabAtom } from '@/atoms/settings-tab'
import {
  automationSettingsLoadingAtom,
  computerUseCapabilitiesAtom,
  computerUsePermissionStatusAtom,
} from '@/atoms/automation-settings'
import { SettingsCard, SettingsSection } from './primitives'

const AI_SDK_PROVIDERS = getAgentCompatibleProviders('ai-sdk')

export function AutomationSettings(): React.ReactElement {
  const [, setActiveTab] = useAtom(settingsTabAtom)
  const [capabilities, setCapabilities] = useAtom(computerUseCapabilitiesAtom)
  const [permissionStatus, setPermissionStatus] = useAtom(computerUsePermissionStatusAtom)
  const [loading, setLoading] = useAtom(automationSettingsLoadingAtom)
  const [stopping, setStopping] = React.useState(false)

  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [nextCapabilities, nextStatus] = await Promise.all([
        window.electronAPI.getComputerUseCapabilities(),
        window.electronAPI.getComputerUseStatus(),
      ])
      setCapabilities(nextCapabilities)
      setPermissionStatus(nextStatus)
    } catch (error) {
      console.error('[自动化设置] 读取 Computer Use 状态失败:', error)
      toast.error('读取 Computer Use 状态失败')
    } finally {
      setLoading(false)
    }
  }, [setCapabilities, setLoading, setPermissionStatus])

  React.useEffect(() => { void refresh() }, [refresh])

  const requestPermissions = async (): Promise<void> => {
    setLoading(true)
    try {
      const status = await window.electronAPI.requestComputerUsePermissions()
      setPermissionStatus(status)
      toast.success(status.message)
    } catch (error) {
      console.error('[自动化设置] 请求 Computer Use 授权失败:', error)
      toast.error(error instanceof Error ? error.message : '请求系统授权失败')
    } finally {
      setLoading(false)
    }
  }

  const stopAllWebBridges = async (): Promise<void> => {
    setStopping(true)
    try {
      const count = await window.electronAPI.stopAllWebBridges()
      toast.success(count === 0 ? '当前没有受管浏览器会话' : `已停止 ${count} 个受管浏览器会话`)
    } catch (error) {
      console.error('[自动化设置] 停止受管浏览器失败:', error)
      toast.error('停止受管浏览器失败')
    } finally {
      setStopping(false)
    }
  }

  const computerUseReady = Boolean(permissionStatus?.supported && permissionStatus.accessibility && permissionStatus.screenRecording)

  return <div className="space-y-5">
    <SettingsSection
      title="Computer Use"
      description="查看系统能力与授权状态。实际点击、输入和高风险操作仍需逐次经 Agent 权限流程确认。"
      action={<Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}><RefreshCw className={loading ? 'mr-2 size-4 animate-spin' : 'mr-2 size-4'} />刷新</Button>}
    >
      <SettingsCard divided={false} className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-primary/10 p-2.5 text-primary"><MonitorCog className="size-5" /></div>
            <div>
              <div className="flex items-center gap-2 font-medium">
                {loading ? <LoaderCircle className="size-4 animate-spin text-muted-foreground" /> : computerUseReady ? <CircleCheck className="size-4 text-emerald-500" /> : <CircleAlert className="size-4 text-amber-500" />}
                {computerUseReady ? '已具备执行条件' : '需要检查或完成系统授权'}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{permissionStatus?.message ?? '正在读取系统授权状态…'}</p>
            </div>
          </div>
          <Button onClick={() => void requestPermissions()} disabled={loading || !permissionStatus?.supported}>请求系统授权</Button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <StatusBadge label="平台支持" value={permissionStatus?.supported} pending={!permissionStatus} />
          <StatusBadge label="辅助功能" value={permissionStatus?.accessibility} pending={!permissionStatus} />
          <StatusBadge label="屏幕录制" value={permissionStatus?.screenRecording} pending={!permissionStatus} />
          <StatusBadge label="窗口识别" value={capabilities?.frontmostWindow} pending={!capabilities} />
        </div>
        {capabilities && <p className="text-xs text-muted-foreground">{capabilities.message} · 截图：{capabilities.screenshot ? '可用' : '不可用'} · 系统输入：{capabilities.input ? '可用' : '不可用'}</p>}
      </SettingsCard>
    </SettingsSection>

    <SettingsSection title="受管浏览器安全控制" description="Web Bridge 每个会话独立隔离，默认只允许 HTTP(S) 导航；上传必须由用户在系统文件选择器中确认。">
      <SettingsCard divided={false} className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 size-5 text-amber-500" />
          <p className="max-w-2xl text-sm text-muted-foreground">紧急停止会关闭当前所有受管浏览器窗口和 CDP 连接，不会删除会话记录或本地操作审计。Computer Use 不会在有可用结构化页面元素时接管网页操作。</p>
        </div>
        <Button variant="destructive" onClick={() => void stopAllWebBridges()} disabled={stopping}><Square className="mr-2 size-4" />{stopping ? '停止中…' : '停止全部受管浏览器'}</Button>
      </SettingsCard>
    </SettingsSection>

    <SettingsSection title="AI SDK Runtime" description="此处展示本地内置能力，不读取或暴露任何 API Key；实际连通性请在“模型配置”中测试对应渠道。">
      <SettingsCard divided={false} className="space-y-4">
        <div className="flex items-start gap-3">
          <Terminal className="mt-0.5 size-5 text-primary" />
          <p className="text-sm text-muted-foreground">AI SDK 支持流式文本、工具活动、MCP、Plan、AskUser 与 Sub Agent；流中 API 错误会被捕获并写入会话错误状态。fork/rewind 采用 history replay，不承诺 SDK 原生文件快照恢复。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {AI_SDK_PROVIDERS.map((provider) => {
            const capability = AGENT_PROVIDER_RUNTIME_CAPABILITIES[provider]
            return <span key={provider} className="rounded-full bg-muted px-2.5 py-1 text-xs text-foreground/85">{provider} · {capability.runtimeProtocols?.['ai-sdk'] ?? capability.protocol}</span>
          })}
        </div>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => setActiveTab('channels')}>前往模型配置测试</Button>
          <Button variant="outline" onClick={() => setActiveTab('operation-audit')}>查看本地操作审计</Button>
        </div>
      </SettingsCard>
    </SettingsSection>
  </div>
}

function StatusBadge({ label, value, pending }: { label: string; value: boolean | undefined; pending: boolean }): React.ReactElement {
  const ready = value === true
  return <div className="rounded-lg bg-muted/70 px-3 py-2 text-sm">
    <div className="text-xs text-muted-foreground">{label}</div>
    <div className={ready ? 'mt-1 font-medium text-emerald-600 dark:text-emerald-400' : 'mt-1 font-medium text-amber-600 dark:text-amber-400'}>{pending ? '读取中…' : ready ? '已就绪' : '未就绪'}</div>
  </div>
}
