import * as React from 'react'
import { CheckCircle2, Eye, EyeOff, Loader2, Trash2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import type { TypeSafeJudgmentSettings } from '@gravitas/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingsCard, SettingsSection } from './primitives'

export function TypeSafeJudgmentSettingsCard(): React.ReactElement {
  const [settings, setSettings] = React.useState<TypeSafeJudgmentSettings | null>(null)
  const [apiKey, setApiKey] = React.useState('')
  const [showApiKey, setShowApiKey] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<{ success: boolean; message: string } | null>(null)

  React.useEffect(() => {
    window.electronAPI.getTypeSafeJudgmentSettings()
      .then(setSettings)
      .catch((error: unknown) => {
        console.error('[TypeSafe 设置] 加载失败:', error)
        toast.error('TypeSafe 设置加载失败')
      })
  }, [])

  const update = async (patch: Parameters<typeof window.electronAPI.updateTypeSafeJudgmentSettings>[0]): Promise<void> => {
    try {
      const next = await window.electronAPI.updateTypeSafeJudgmentSettings(patch)
      setSettings(next)
    } catch (error) {
      console.error('[TypeSafe 设置] 更新失败:', error)
      toast.error('TypeSafe 设置保存失败')
    }
  }

  const saveApiKey = async (): Promise<void> => {
    const key = apiKey.trim()
    if (!key) return
    setSaving(true)
    try {
      const next = await window.electronAPI.updateTypeSafeJudgmentSettings({ apiKey: key })
      setSettings(next)
      setApiKey('')
      setTestResult(null)
      toast.success(next.credentialStorage === 'encrypted'
        ? 'TypeSafe API Key 已加密保存'
        : '系统加密不可用，API Key 仅在本次运行中有效')
    } catch (error) {
      console.error('[TypeSafe 设置] 保存 API Key 失败:', error)
      toast.error('TypeSafe API Key 保存失败')
    } finally {
      setSaving(false)
    }
  }

  const clearApiKey = async (): Promise<void> => {
    try {
      const next = await window.electronAPI.clearTypeSafeApiKey()
      setSettings(next)
      setApiKey('')
      setTestResult(null)
      toast.success('TypeSafe API Key 已清除')
    } catch (error) {
      console.error('[TypeSafe 设置] 清除 API Key 失败:', error)
      toast.error('TypeSafe API Key 清除失败')
    }
  }

  const testConnection = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await window.electronAPI.testTypeSafeConnection())
    } catch (error) {
      setTestResult({ success: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setTesting(false)
    }
  }

  if (!settings) {
    return <div className="py-8 text-center text-sm text-muted-foreground">加载 TypeSafe 设置中...</div>
  }

  return (
    <SettingsSection
      title="TypeSafe 判断服务"
      description="用固定版本的 System One 判断 Skill 路由与 Chat / Agent 模式"
      action={
        <Switch
          checked={settings.enabled}
          disabled={!settings.hasApiKey}
          onCheckedChange={(enabled) => void update({ enabled })}
        />
      }
    >
      <SettingsCard divided={false}>
        <div className="space-y-5 p-4">
          <div className="rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">
            默认关闭。启用后只发送当前用户消息的截断文本、通用附件类别，以及 shadow 判断所需的已启用 Skill 名称与简介；不会发送历史对话、附件内容、工具结果、本地路径或 API Key。Chat 推荐会增加一次短暂预判断，服务异常时自动回退 Gravitas 现有行为。
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-medium">API Key</label>
              <span className="text-xs text-muted-foreground">
                {settings.hasApiKey
                  ? settings.credentialStorage === 'encrypted' ? '已加密保存' : '仅本次运行有效'
                  : '未配置'}
              </span>
            </div>
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  placeholder={settings.hasApiKey ? '输入新 Key 以替换现有凭据' : 'ts_...'}
                  onChange={(event) => setApiKey(event.target.value)}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((value) => !value)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <Button size="sm" onClick={() => void saveApiKey()} disabled={saving || !apiKey.trim()}>
                {saving ? <Loader2 size={14} className="animate-spin" /> : '保存'}
              </Button>
              {settings.hasApiKey && (
                <Button size="icon" variant="outline" onClick={() => void clearApiKey()} title="清除 API Key">
                  <Trash2 size={15} />
                </Button>
              )}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Skill 路由 shadow</p>
                  <p className="mt-1 text-xs text-muted-foreground">只记录预测，不改变实际 Skill 调用。</p>
                </div>
                <Switch
                  checked={settings.skillShadowEnabled}
                  disabled={!settings.hasApiKey}
                  onCheckedChange={(skillShadowEnabled) => void update({ skillShadowEnabled })}
                />
              </div>
            </div>
            <div className="rounded-lg bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Chat → Agent 推荐</p>
                  <p className="mt-1 text-xs text-muted-foreground">沿用现有推荐工具开关；失败时回退原判断。</p>
                </div>
                <Switch
                  checked={settings.chatAgentRecommendEnabled}
                  disabled={!settings.hasApiKey}
                  onCheckedChange={(chatAgentRecommendEnabled) => void update({ chatAgentRecommendEnabled })}
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 pt-4">
            <p className="text-xs text-muted-foreground">固定模型：<code>{settings.model}</code></p>
            <Button size="sm" variant="outline" disabled={!settings.hasApiKey || testing} onClick={() => void testConnection()}>
              {testing ? <><Loader2 size={14} className="mr-1.5 animate-spin" />测试中...</> : '测试连接'}
            </Button>
          </div>

          {testResult && (
            <div className={`flex items-start gap-2 rounded-lg p-3 text-sm ${testResult.success ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-destructive/10 text-destructive'}`}>
              {testResult.success ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
              <span>{testResult.message}</span>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
