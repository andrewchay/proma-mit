/**
 * VisionRelaySettings — 视觉助手（Vision Relay）设置
 *
 * 为纯文本 Pi 模型（如 DeepSeek V4）配置视觉中转：选择支持图片输入的
 * 渠道与模型，Agent 需要看图时自动把图片发给视觉模型，返回结构化描述。
 */

import * as React from 'react'
import { Eye, Info } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SettingsSection, SettingsCard, SettingsRow } from './primitives'
import type { Channel } from '@gravitas/shared'
import type { VisionRelayConfig } from '@/types/settings'

/** 已知支持图片输入的供应商（用于过滤可选渠道） */
const VISION_CAPABLE_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'google',
  'zhipu',
  'doubao',
  'qwen',
  'custom',
])

export function VisionRelaySettings(): React.ReactElement {
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [config, setConfig] = React.useState<VisionRelayConfig | undefined>()
  const [loading, setLoading] = React.useState(true)

  // 加载渠道与当前配置
  React.useEffect(() => {
    let cancelled = false
    Promise.all([window.electronAPI.listChannels(), window.electronAPI.getSettings()])
      .then(([list, settings]) => {
        if (cancelled) return
        setChannels(list.filter((c) => VISION_CAPABLE_PROVIDERS.has(c.provider) && c.enabled))
        setConfig(settings.visionRelay)
      })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const selectedChannel = channels.find((c) => c.id === config?.channelId)
  const selectedChannelModels = selectedChannel?.models ?? []

  /** 保存配置 */
  const saveConfig = async (next: VisionRelayConfig): Promise<void> => {
    setConfig(next)
    try {
      await window.electronAPI.updateSettings({ visionRelay: next })
    } catch (error) {
      console.error('[视觉助手] 保存配置失败:', error)
      toast.error('保存视觉助手配置失败')
    }
  }

  const handleEnabledChange = async (enabled: boolean): Promise<void> => {
    if (!enabled) {
      await saveConfig({ enabled: false, channelId: config?.channelId ?? '', modelId: config?.modelId ?? '' })
      return
    }
    // 启用时要求已选渠道+模型
    if (!config?.channelId || !config.modelId) {
      toast.error('请先选择视觉渠道与模型')
      return
    }
    await saveConfig({ enabled: true, channelId: config.channelId, modelId: config.modelId })
  }

  if (loading) {
    return <div className="p-4 text-sm text-muted-foreground">正在加载…</div>
  }

  return (
    <SettingsSection
      title="视觉助手（Vision Relay）"
      description="让纯文本 Pi 模型（如 DeepSeek V4）通过支持视觉的渠道理解图片"
    >
      <SettingsCard>
        <SettingsRow
          label="启用视觉助手"
          description="启用后，DeepSeek V4 等文本模型需要看图时会自动调用配置的视觉渠道"
        >
          <Switch
            checked={config?.enabled ?? false}
            onCheckedChange={(value) => { void handleEnabledChange(value) }}
          />
        </SettingsRow>

        <div className="space-y-4 px-4 py-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">视觉渠道</label>
            <Select
              value={config?.channelId || undefined}
              onValueChange={(channelId) => {
                const channel = channels.find((c) => c.id === channelId)
                void saveConfig({
                  enabled: config?.enabled ?? false,
                  channelId,
                  modelId: channel?.models?.[0]?.id ?? '',
                })
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择支持图片的渠道" />
              </SelectTrigger>
              <SelectContent>
                {channels.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">没有可用的视觉渠道，请先在「渠道设置」中添加</div>
                ) : channels.map((channel) => (
                  <SelectItem key={channel.id} value={channel.id}>
                    {channel.name} · {channel.provider}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">视觉模型</label>
            <Select
              value={config?.modelId || undefined}
              onValueChange={(modelId) => {
                void saveConfig({ enabled: config?.enabled ?? false, channelId: config?.channelId ?? '', modelId })
              }}
              disabled={!config?.channelId || selectedChannelModels.length === 0}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={config?.channelId ? '选择模型' : '请先选择渠道'} />
              </SelectTrigger>
              <SelectContent>
                {selectedChannelModels.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.name ?? model.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-2.5 text-[11px] leading-5 text-muted-foreground">
            <Eye className="size-3.5 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-foreground">工作原理</p>
              <p>
                当 DeepSeek V4（deepseek-v4-pro / deepseek-v4-flash）收到图片时，
                Agent 会调用「视觉助手」工具，把图片发送给你选择的视觉渠道/模型，
                返回结构化描述（answer / observations / limitations）。
                图片/OCR 内容视为不可信数据，不会作为指令执行。
              </p>
            </div>
          </div>

          {config?.enabled && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Info className="size-3.5" />
              当前路由：{channels.find((c) => c.id === config.channelId)?.name ?? config.channelId} · {config.modelId}
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
