/**
 * ExtensionSettings — 扩展中心（P1-2b）。
 *
 * 展示第一方内置插件列表：名称/版本/状态/启停/权限摘要/surfaces。
 * 当前仅灵动岛为样板；第三方插件暂不开放（P2）。
 */

import * as React from 'react'
import { SettingsSection } from './primitives/SettingsSection'
import { Button } from '@/components/ui/button'
import { SettingsCard } from './primitives/SettingsCard'
import { SettingsRow } from './primitives/SettingsRow'
import { SettingsToggle } from './primitives/SettingsToggle'
import { toast } from 'sonner'

/** 插件状态视图（与主进程 PluginStateView 对应） */
interface PluginStateView {
  id: string
  name: string
  version: string
  description?: string
  publisher: string
  supported: boolean
  state: 'discovered' | 'installed' | 'enabled' | 'disabled' | 'error' | 'uninstalled'
  enabled: boolean
  surfaces: string[]
  subscriptions: string[]
  permissions: Record<string, unknown>
  error?: string
}

const SURFACE_LABEL: Record<string, string> = {
  overlay: '系统浮层',
  notification: '通知',
  'menu-bar': '菜单栏',
  settings: '设置页',
  preview: '文件预览',
  'workflow-node': 'Workflow 节点',
  'bridge-connector': '外部连接',
}

const SUBSCRIPTION_LABEL: Record<string, string> = {
  'app.started': '任务开始',
  'app.progress': '任务进行',
  'app.waiting_action': '等待处理',
  'app.completed': '任务完成',
  'app.failed': '任务失败',
}

export function ExtensionSettings(): React.ReactElement {
  const [plugins, setPlugins] = React.useState<PluginStateView[]>([])
  const [loading, setLoading] = React.useState(true)

  // PH2-F：插件/SDK 开放——按 manifest 导入第三方插件
  const [importDraft, setImportDraft] = React.useState('')
  const [showImport, setShowImport] = React.useState(false)

  const handleImport = async (): Promise<void> => {
    const raw = importDraft
    if (!raw) return
    try {
      const manifest = JSON.parse(raw)
      const ok = await window.electronAPI.importPlugin(manifest)
      if (ok) {
        toast.success(`已导入插件「${manifest.name ?? manifest.id}」`)
        setImportDraft('')
        setShowImport(false)
        await load()
      } else {
        toast.error('导入失败（id 已存在或 manifest 不完整）')
      }
    } catch (err) {
      toast.error(`manifest 解析失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.listPluginStates()
      setPlugins(result as PluginStateView[])
    } catch (err) {
      console.error('[扩展] 读取插件列表失败:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const handleToggle = async (plugin: PluginStateView, checked: boolean): Promise<void> => {
    try {
      const updated = await window.electronAPI.setPluginEnabled(plugin.id, checked)
      if (updated) {
        setPlugins((prev) => prev.map((p) => (p.id === plugin.id ? { ...updated as PluginStateView } : p)))
        toast.success(checked ? `「${plugin.name}」已启用` : `「${plugin.name}」已停用`)
      } else {
        toast.error(`「${plugin.name}」操作失败`)
      }
    } catch (err) {
      toast.error(`「${plugin.name}」操作失败：${err instanceof Error ? err.message : '未知原因'}`)
    }
  }

  return (
    <SettingsSection
      title="扩展"
      description="管理 Gravitas 的扩展（第一方内置 + 第三方按 manifest 导入）。扩展可贡献系统浮层、通知、菜单栏等能力"
      action={
        <Button variant="outline" size="sm" onClick={() => setShowImport((v) => !v)}>
          {showImport ? '收起' : '导入插件'}
        </Button>
      }
    >
      {showImport && (
        <div className="border-b border-border/50 px-4 py-3 space-y-2">
          <textarea
            value={importDraft}
            onChange={(e) => setImportDraft(e.target.value)}
            rows={5}
            placeholder={'粘贴第三方插件 manifest JSON，例如：\n{ "id": "com.xxx.plugin", "name": "我的插件", "version": "1.0.0", "surfaces": [], "permissions": { "events": false }, "entrypoints": {} }'}
            className="w-full rounded-md border bg-background px-3 py-2 text-xs font-mono resize-none"
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void handleImport()} disabled={!importDraft.trim()}>导入</Button>
          </div>
        </div>
      )}
      <SettingsCard>
        {loading ? (
          <SettingsRow label="加载中…">
            <span className="text-[13px] text-foreground/40">正在读取扩展列表</span>
          </SettingsRow>
        ) : plugins.length === 0 ? (
          <SettingsRow label="暂无扩展">
            <span className="text-[13px] text-foreground/40">当前没有可用的扩展</span>
          </SettingsRow>
        ) : (
          plugins.map((plugin) => (
            <div key={plugin.id} className="py-2 border-b border-border/50 last:border-b-0">
              <SettingsToggle
                label={plugin.name}
                description={`${plugin.description ?? ''}${plugin.supported ? '' : '（当前平台不支持）'}`}
                checked={plugin.enabled}
                disabled={!plugin.supported}
                onCheckedChange={(checked) => void handleToggle(plugin, checked)}
              />
              <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3 -mt-1">
                <span className="px-1.5 py-0.5 rounded bg-foreground/[0.06] text-[11px] text-foreground/50">
                  v{plugin.version}
                </span>
                {plugin.surfaces.map((surface) => (
                  <span key={surface} className="px-1.5 py-0.5 rounded bg-foreground/[0.06] text-[11px] text-foreground/50">
                    {SURFACE_LABEL[surface] ?? surface}
                  </span>
                ))}
                {plugin.subscriptions.slice(0, 3).map((sub) => (
                  <span key={sub} className="px-1.5 py-0.5 rounded bg-primary/5 text-[11px] text-primary/70">
                    {SUBSCRIPTION_LABEL[sub] ?? sub}
                  </span>
                ))}
                {plugin.error && (
                  <span className="px-1.5 py-0.5 rounded bg-destructive/10 text-[11px] text-destructive">
                    {plugin.error}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  )
}
