/**
 * CompanionSettings — 远程访问（手机浏览器）设置
 *
 * 开启后主进程监听局域网端口，手机浏览器扫码/输入地址打开 Companion 单页；
 * 首次访问需输入一次性配对码换取长期 token。
 */

import * as React from 'react'
import { Copy, KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingsSection, SettingsCard, SettingsRow } from './primitives'

export function CompanionSettings(): React.ReactElement {
  const [enabled, setEnabled] = React.useState(false)
  const [port, setPort] = React.useState('8790')
  const [status, setStatus] = React.useState<{ running: boolean; port: number; lanUrl?: string } | null>(null)
  const [pairingCode, setPairingCode] = React.useState('')
  const [countdown, setCountdown] = React.useState(0)
  const [loading, setLoading] = React.useState(true)

  // 加载当前配置与服务状态
  React.useEffect(() => {
    let cancelled = false
    Promise.all([window.electronAPI.getSettings(), window.electronAPI.companion.getStatus()])
      .then(([settings, status]) => {
        if (cancelled) return
        setEnabled(settings.companionServer?.enabled ?? false)
        setPort(String(settings.companionServer?.port ?? 8790))
        setStatus(status)
      })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // 配对码 120 秒倒计时
  React.useEffect(() => {
    if (countdown <= 0) return
    const timer = setInterval(() => setCountdown((v) => (v > 0 ? v - 1 : 0)), 1000)
    return () => clearInterval(timer)
  }, [countdown])

  const saveEnabled = async (next: boolean): Promise<void> => {
    setEnabled(next)
    try {
      await window.electronAPI.updateSettings({ companionServer: { enabled: next } })
      // 等主进程联动启停后刷新状态
      setTimeout(async () => setStatus(await window.electronAPI.companion.getStatus()), 400)
    } catch (error) {
      console.error('[Companion] 保存失败:', error)
      toast.error('保存远程访问配置失败')
      setEnabled(!next)
    }
  }

  const savePort = async (value: string): Promise<void> => {
    const parsed = Number(value)
    setPort(value)
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) return
    try {
      await window.electronAPI.updateSettings({ companionServer: { port: parsed } })
      toast.info('端口已保存，重启应用后生效')
    } catch (error) {
      console.error('[Companion] 保存端口失败:', error)
    }
  }

  const generateCode = async (): Promise<void> => {
    try {
      const code = await window.electronAPI.companion.generatePairingCode()
      setPairingCode(code)
      setCountdown(120)
    } catch (error) {
      console.error('[Companion] 生成配对码失败:', error)
      toast.error('生成配对码失败，请确认远程访问已开启')
    }
  }

  const copyLanUrl = async (): Promise<void> => {
    if (!status?.lanUrl) return
    await navigator.clipboard.writeText(status.lanUrl)
    toast.success('已复制访问地址')
  }

  return (
    <SettingsSection
      title="远程访问"
      description="在手机浏览器上查看会话、确认权限请求与发送消息。建议搭配 Tailscale 使用，避免直接暴露公网。"
    >
      <SettingsCard>
        <SettingsRow
          label="启用远程访问"
          description={status?.running ? `服务运行中，端口 ${status.port}` : '未运行；开启后主进程在局域网内监听'}
        >
          <Switch
            checked={enabled}
            onCheckedChange={(v) => void saveEnabled(v)}
            disabled={loading}
          />
        </SettingsRow>

        <SettingsRow label="监听端口" description="默认 8790，修改后重启应用生效">
          <Input
            className="w-28"
            inputMode="numeric"
            value={port}
            onChange={(e) => void savePort(e.target.value)}
            disabled={loading}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard>
        <SettingsRow
          label="访问地址"
          description={status?.lanUrl ? '同一 Wi-Fi 下的手机浏览器打开此地址' : '服务未运行，开启后显示'}
        >
          <Button variant="outline" size="sm" onClick={() => void copyLanUrl()} disabled={!status?.lanUrl}>
            <Copy size={14} /> 复制
          </Button>
        </SettingsRow>
        {status?.lanUrl && (
          <div className="mt-2 rounded-md bg-muted px-3 py-2 font-mono text-sm break-all select-all">
            {status.lanUrl}
          </div>
        )}

        <SettingsRow
          label="配对码"
          description={countdown > 0 ? `${pairingCode}（${countdown} 秒后失效，单次有效）` : '生成 6 位一次性配对码，手机首次访问时输入'}
        >
          <Button variant="outline" size="sm" onClick={() => void generateCode()} disabled={!enabled}>
            <KeyRound size={14} /> 生成
          </Button>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  )
}
