/**
 * CalendarSyncSettings - 日历同步设置
 *
 * 从侧边栏的独立模块移到设置面板中。
 * 提供日历源管理（添加/删除/启用/同步）功能。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import {
  CalendarDays,
  RefreshCw,
  Plus,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Cloud,
  Apple,
  HardDrive,
  ArrowRightLeft,
  ArrowDown,
  ArrowUp,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  calendarSourcesAtom,
  type CalendarSource,
} from '@/atoms/paa-atoms'

// ===== 常量配置 =====

const PROVIDER_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  google: { label: 'Google Calendar', icon: Cloud, color: 'text-blue-600' },
  apple: { label: 'Apple Calendar', icon: Apple, color: 'text-gray-800' },
  outlook: { label: 'Outlook', icon: Cloud, color: 'text-blue-500' },
  local: { label: '本地日历', icon: HardDrive, color: 'text-green-600' },
  other: { label: '其他', icon: CalendarDays, color: 'text-muted-foreground' },
}

const DIRECTION_LABELS: Record<string, string> = {
  'one-way-in': '单向导入',
  'one-way-out': '单向导出',
  'two-way': '双向同步',
}

const DIRECTION_ICONS: Record<string, React.ElementType> = {
  'one-way-in': ArrowDown,
  'one-way-out': ArrowUp,
  'two-way': ArrowRightLeft,
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ===== 子组件：日历源卡片 =====

function SourceCard({
  source,
  isSyncing,
  onToggle,
  onSync,
  onDelete,
}: {
  source: CalendarSource
  isSyncing: boolean
  onToggle: (id: string, enabled: boolean) => void
  onSync: (id: string) => void
  onDelete: (id: string) => void
}): React.ReactElement {
  const provider = (PROVIDER_CONFIG[source.provider] ?? PROVIDER_CONFIG.other)!
  const DirectionIcon = DIRECTION_ICONS[source.syncDirection] ?? ArrowRightLeft

  return (
    <div className={`border rounded-lg p-4 hover:shadow-sm transition-shadow ${!source.enabled ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div className={`w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0 ${provider.color}`}>
            <provider.icon className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-sm">{source.name}</h3>
              <Badge variant="secondary" className="text-[10px] h-4 px-1">
                {provider.label}
              </Badge>
            </div>
            <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1">
                <DirectionIcon className="w-3 h-3" />
                {DIRECTION_LABELS[source.syncDirection]}
              </span>
              {source.lastSyncAt && (
                <span className="flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" />
                  上次同步: {new Date(source.lastSyncAt).toLocaleString('zh-CN')}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-3">
          <Switch
            checked={source.enabled}
            onCheckedChange={(v) => onToggle(source.id, v)}
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={() => onSync(source.id)}
            disabled={!source.enabled || isSyncing}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
            onClick={() => onDelete(source.id)}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

// ===== 主组件 =====

export function CalendarSyncSettings(): React.ReactElement {
  const [sources, setSources] = useAtom(calendarSourcesAtom)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [syncingId, setSyncingId] = React.useState<string | null>(null)
  const [syncNotice, setSyncNotice] = React.useState<{ status: 'success' | 'error'; message: string } | null>(null)
  const [newSource, setNewSource] = React.useState({
    name: '',
    provider: 'google' as CalendarSource['provider'],
    syncDirection: 'two-way' as CalendarSource['syncDirection'],
  })

  const handleCreate = async () => {
    if (!newSource.name.trim()) return
    try {
      const source = await window.electronAPI.paa.calendarSync.createSource({
        name: newSource.name.trim(),
        provider: newSource.provider,
        config: { credentialsPath: '' },
        enabled: true,
        syncDirection: newSource.syncDirection,
      })
      setSources((prev) => [...prev, source as CalendarSource])
      setNewSource({ name: '', provider: 'google', syncDirection: 'two-way' })
      setDialogOpen(false)
      setSyncNotice({ status: 'success', message: `日历源「${newSource.name.trim()}」添加成功` })
    } catch (err) {
      console.error('创建日历源失败:', err)
      setSyncNotice({ status: 'error', message: `添加失败：${getErrorMessage(err)}` })
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const success = await window.electronAPI.paa.calendarSync.deleteSource(id)
      if (success) {
        setSources((prev) => prev.filter((s) => s.id !== id))
      }
    } catch (err) {
      console.error('删除日历源失败:', err)
    }
  }

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      const updated = await window.electronAPI.paa.calendarSync.updateSource(id, { enabled })
      if (updated) {
        setSources((prev) => prev.map((s) => (s.id === id ? (updated as CalendarSource) : s)))
      }
    } catch (err) {
      console.error('更新日历源失败:', err)
    }
  }

  const handleSync = async (id: string) => {
    setSyncingId(id)
    setSyncNotice(null)
    try {
      const result = await window.electronAPI.paa.calendarSync.syncSource(id)
      const updatedSources = await window.electronAPI.paa.calendarSync.listSources()
      setSources(updatedSources as CalendarSource[])
      setSyncNotice({ status: 'success', message: '同步成功' })
    } catch (err) {
      console.error('同步失败:', err)
      setSyncNotice({ status: 'error', message: `同步失败：${getErrorMessage(err)}` })
    } finally {
      setSyncingId(null)
    }
  }

  const handleSyncAll = async () => {
    setSyncNotice(null)
    const enabledCount = sources.filter((s) => s.enabled).length
    if (enabledCount === 0) {
      setSyncNotice({
        status: 'error',
        message: sources.length === 0
          ? '还没有日历源，请先添加一个日历源'
          : '没有启用的日历源，请先打开至少一个日历源的开关',
      })
      return
    }
    try {
      await window.electronAPI.paa.calendarSync.syncAll()
      const updatedSources = await window.electronAPI.paa.calendarSync.listSources()
      setSources(updatedSources as CalendarSource[])
      setSyncNotice({ status: 'success', message: '全部同步成功' })
    } catch (err) {
      console.error('全部同步失败:', err)
      setSyncNotice({ status: 'error', message: `全部同步失败：${getErrorMessage(err)}` })
    }
  }

  const enabledCount = sources.filter((s) => s.enabled).length

  return (
    <div className="space-y-6">
      {/* 标题与操作 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <CalendarDays className="w-5 h-5 text-primary" />
          <div>
            <h2 className="text-base font-semibold">日历同步</h2>
            <p className="text-xs text-muted-foreground">
              管理外部日历源，同步事件到日程管家
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={handleSyncAll}
            disabled={syncingId !== null}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncingId !== null ? 'animate-spin' : ''}`} />
            全部同步
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="h-7 text-xs">
                <Plus className="w-3.5 h-3.5 mr-1" />
                添加源
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>添加日历源</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 pt-2">
                <div>
                  <label className="text-xs font-medium mb-1 block">名称</label>
                  <Input
                    value={newSource.name}
                    onChange={(e) => setNewSource((s) => ({ ...s, name: e.target.value }))}
                    placeholder="例如：Google 工作日历"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">提供商</label>
                  <Select
                    value={newSource.provider}
                    onValueChange={(v) => setNewSource((s) => ({ ...s, provider: v as CalendarSource['provider'] }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(PROVIDER_CONFIG).map(([key, config]) => (
                        <SelectItem key={key} value={key}>
                          {config.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">同步方向</label>
                  <Select
                    value={newSource.syncDirection}
                    onValueChange={(v) => setNewSource((s) => ({ ...s, syncDirection: v as CalendarSource['syncDirection'] }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(DIRECTION_LABELS).map(([key, label]) => (
                        <SelectItem key={key} value={key}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={handleCreate} className="w-full" disabled={!newSource.name.trim()}>
                  确认添加
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* 状态提示 */}
      {syncNotice && (
        <div className={`px-4 py-2 text-xs rounded-md flex items-center gap-2 ${
          syncNotice.status === 'success'
            ? 'bg-green-50 text-green-700 border border-green-200'
            : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {syncNotice.status === 'success' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
          <span>{syncNotice.message}</span>
          <button
            type="button"
            onClick={() => setSyncNotice(null)}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
      )}

      {/* 源列表 */}
      <div className="space-y-3">
        {sources.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground border rounded-lg">
            <CalendarDays className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">暂无日历源</p>
            <p className="text-xs mt-1 opacity-60">点击右上角「添加源」创建第一个日历源</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary" className="text-[10px] h-4">
                {enabledCount}/{sources.length} 启用
              </Badge>
            </div>
            {sources.map((source) => (
              <SourceCard
                key={source.id}
                source={source}
                isSyncing={syncingId === source.id}
                onToggle={handleToggle}
                onSync={handleSync}
                onDelete={handleDelete}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
