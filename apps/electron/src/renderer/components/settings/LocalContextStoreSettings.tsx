/**
 * LocalContextStoreSettings — 本地上下文存储设置
 *
 * 本地优先的上下文图存储开关，与云端记忆（MemOS Cloud）并行。
 * 启用后 Agent 会自动把会话消息索引到工作区隔离的本地 context-store，
 * 并在每条用户消息前自动召回相关历史记录注入上下文。
 *
 * 默认启用（本地优先，数据不出本机）。
 */

import * as React from 'react'
import { toast } from 'sonner'
import { HardDrive, Info } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { SettingsSection, SettingsCard, SettingsRow } from './primitives'

export function LocalContextStoreSettings(): React.ReactElement {
  const [enabled, setEnabled] = React.useState(true)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)

  // 加载本地上下文存储配置（默认启用）
  React.useEffect(() => {
    window.electronAPI
      .getSettings()
      .then((settings) => {
        setEnabled(settings.localContextStore?.enabled !== false)
      })
      .catch((err: unknown) => console.error('[本地上下文存储] 加载配置失败:', err))
      .finally(() => setLoading(false))
  }, [])

  /** 保存配置 */
  const saveEnabled = async (value: boolean): Promise<void> => {
    setSaving(true)
    setEnabled(value)
    try {
      await window.electronAPI.updateSettings({ localContextStore: { enabled: value } })
      toast.success(value ? '已启用本地上下文存储' : '已关闭本地上下文存储，历史记录仍保留在本地')
    } catch (error) {
      console.error('[本地上下文存储] 保存配置失败:', error)
      setEnabled(!value) // 回滚
      toast.error('保存本地上下文存储配置失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="py-4 text-sm text-muted-foreground text-center">加载中...</div>
  }

  return (
    <SettingsSection
      title="本地上下文存储"
      description="把重要会话索引到本地 context-store，Agent 可跨会话召回，数据只存本机"
    >
      <SettingsCard>
        <SettingsRow
          label="启用本地上下文存储"
          description="启用后 Agent 自动索引会话消息，并在每次回复时自动召回相关历史上下文"
        >
          <Switch
            checked={enabled}
            onCheckedChange={(value) => { void saveEnabled(value) }}
            disabled={saving}
          />
        </SettingsRow>

        <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-[11px] leading-5 text-muted-foreground">
          <HardDrive className="size-3.5 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-foreground">本地优先，隐私安全</p>
            <p>
              会话消息保存在工作区隔离的本地数据库（如上下文存储仅存本机，不依赖任何云端服务）。
              与 MemOS Cloud 记忆并行：云端记「长期偏好」，本地存「工作区历史」，都可用于跨会话回忆。
            </p>
          </div>
          <Info className="size-3.5 mt-0.5 shrink-0 text-muted-foreground/50" />
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
