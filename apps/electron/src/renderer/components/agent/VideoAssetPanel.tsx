/**
 * VideoAssetPanel — Campaign 广告视频素材面板
 *
 * 扫描 Campaign 的 `video-assets/` 目录，展示 AI 生成的广告视频（Seedance / MiniMax H3）。
 * 支持内联播放、打开本地文件、删除素材。
 */

import * as React from 'react'
import { Clapperboard, RefreshCw, FolderOpen, Loader2, ExternalLink, Trash2, PencilLine, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/** 与主进程 video-asset-service 返回结构对齐 */
interface VideoAssetEntry {
  name: string
  path: string
  fileUrl: string
  ext: string
  size: number
  duration: number
  resolution: string
  mtimeMs: number
}

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '未知时长'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 根据文件名猜测引擎 */
function guessEngine(name: string): { label: string; tone: string } | null {
  const lower = name.toLowerCase()
  if (lower.includes('seedance')) return { label: 'Seedance', tone: 'text-blue-600 bg-blue-500/10' }
  if (lower.includes('minimax') || lower.includes('h3')) return { label: 'MiniMax H3', tone: 'text-purple-600 bg-purple-500/10' }
  return null
}

interface VideoAssetPanelProps {
  campaignId: string
  onSendToAssistant?: (prompt: string) => void
}

export function VideoAssetPanel({ campaignId, onSendToAssistant }: VideoAssetPanelProps): React.ReactElement {
  const [assets, setAssets] = React.useState<VideoAssetEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [expanded, setExpanded] = React.useState<string | null>(null)
  const [editingName, setEditingName] = React.useState<string | null>(null)
  const [draftName, setDraftName] = React.useState('')

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.listVideoAssets(campaignId)
      setAssets(result)
    } catch (e) {
      toast.error('加载视频素材失败')
      console.error('[VideoAssetPanel]', e)
    } finally {
      setLoading(false)
    }
  }, [campaignId])

  React.useEffect(() => {
    load()
  }, [load])

  const openInFolder = async (path: string) => {
    try {
      await window.electronAPI.showInFolder(path)
    } catch {
      toast.error('无法在文件管理器中显示')
    }
  }

  const openNative = async (path: string) => {
    try {
      await window.electronAPI.openFile(path)
    } catch {
      toast.error('无法打开文件')
    }
  }

  const handleDelete = async (asset: VideoAssetEntry) => {
    try {
      const ok = await window.electronAPI.deleteVideoAsset(campaignId, asset.path)
      if (ok) {
        setAssets((prev) => prev.filter((a) => a.path !== asset.path))
        toast.success('已删除视频素材')
      } else {
        toast.error('删除失败')
      }
    } catch {
      toast.error('删除失败')
    }
  }

  const startRename = (asset: VideoAssetEntry) => {
    setEditingName(asset.path)
    setDraftName(asset.name.replace(/\.[^.]+$/, ''))
  }

  const commitRename = async () => {
    if (!editingName) return
    const target = editingName
    try {
      const res = await window.electronAPI.renameVideoAsset(campaignId, target, draftName)
      if (res.success && res.path) {
        setAssets((prev) =>
          prev.map((a) =>
            a.path === target
              ? { ...a, name: res.path!.split('/').pop() ?? a.name, path: res.path! }
              : a,
          ),
        )
        toast.success('已重命名')
      } else {
        toast.error(res.error ?? '重命名失败')
      }
    } catch (e) {
      toast.error('重命名失败')
    } finally {
      setEditingName(null)
      setDraftName('')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        加载中...
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {assets.length > 0 ? `共 ${assets.length} 个视频素材` : '暂无视频素材'}
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={load} className="h-7 px-2 text-xs">
            <RefreshCw size={13} className="mr-1" />
            刷新
          </Button>
          {onSendToAssistant && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onSendToAssistant('请基于当前 Campaign 创意概念生成广告视频分镜脚本并产出到 video-assets/ 目录。')}
              className="h-7 px-2 text-xs"
            >
              <Clapperboard size={13} className="mr-1" />
              生成视频素材
            </Button>
          )}
        </div>
      </div>

      {assets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center border border-dashed border-border rounded-xl">
          <Clapperboard size={32} className="text-muted-foreground/30 mb-2" />
          <p className="text-sm text-muted-foreground">暂无广告视频素材</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            运行工作流第 15 步「生成广告视频素材」，产物将沉淀到 video-assets/ 目录
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {assets.map((asset) => {
            const engine = guessEngine(asset.name)
            return (
              <div key={asset.path} className="rounded-xl border border-border bg-background overflow-hidden">
                <div className="p-3 flex items-start gap-3">
                  {/* 视频缩略图 / 播放区域 */}
                  <div
                    className="w-32 h-20 rounded-lg bg-black overflow-hidden flex-shrink-0 cursor-pointer relative group"
                    onClick={() => setExpanded(expanded === asset.path ? null : asset.path)}
                  >
                    {expanded === asset.path ? (
                      <video src={asset.fileUrl} controls autoPlay className="w-full h-full object-contain" />
                    ) : (
                      <>
                        <video src={asset.fileUrl} preload="metadata" muted className="w-full h-full object-cover" />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                          <ExternalLink size={18} className="text-white" />
                        </div>
                      </>
                    )}
                  </div>

                  {/* 素材信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {editingName === asset.path ? (
                        <>
                          <input
                            autoFocus
                            value={draftName}
                            onChange={(e) => setDraftName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void commitRename()
                              if (e.key === 'Escape') { setEditingName(null); setDraftName('') }
                            }}
                            className="text-sm bg-background border border-border rounded px-1.5 py-0.5 w-40 focus:outline-none focus:border-primary"
                          />
                          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs text-emerald-600" onClick={() => void commitRename()}>
                            <Check size={13} />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs text-muted-foreground" onClick={() => { setEditingName(null); setDraftName('') }}>
                            <X size={13} />
                          </Button>
                        </>
                      ) : (
                        <span className="text-sm font-medium truncate" title={asset.name}>
                          {asset.name}
                        </span>
                      )}
                      {engine && (
                        <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0', engine.tone)}>
                          {engine.label}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {formatDuration(asset.duration)}
                      {asset.resolution ? ` · ${asset.resolution}` : ''}
                      {` · ${formatSize(asset.size)}`}
                    </div>
                    <div className="text-[10px] text-muted-foreground/60 mt-0.5 truncate" title={asset.path}>
                      {asset.path}
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs text-muted-foreground hover:text-primary"
                        onClick={() => openInFolder(asset.path)}
                      >
                        <FolderOpen size={12} className="mr-1" />
                        显示文件
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs text-muted-foreground hover:text-primary"
                        onClick={() => openNative(asset.path)}
                      >
                        <ExternalLink size={12} className="mr-1" />
                        打开
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs text-muted-foreground hover:text-primary"
                        onClick={() => startRename(asset)}
                      >
                        <PencilLine size={12} className="mr-1" />
                        重命名
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs text-muted-foreground hover:text-red-600"
                        onClick={() => void handleDelete(asset)}
                      >
                        <Trash2 size={12} className="mr-1" />
                        删除
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
