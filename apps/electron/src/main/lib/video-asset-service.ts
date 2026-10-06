/**
 * 视频素材服务 — Campaign 广告视频素材扫描与元数据
 *
 * 扫描 Campaign 工作区的 `video-assets/` 目录，返回可投放的视频文件列表。
 * 视频由 Agent / ma-video-creative 步骤生成，通过文件系统沉淀，此处只做只读索引。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename, dirname, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listAgentWorkspaces } from './agent-workspace-manager'
import { getAgentWorkspacePath } from './config-paths'

/** 支持的视频扩展名 */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi'])

/** 单条视频素材元数据（渲染层展示用） */
export interface VideoAssetEntry {
  /** 文件名 */
  name: string
  /** 文件绝对路径 */
  path: string
  /** 可播放的 file:// URL */
  fileUrl: string
  /** 扩展名 */
  ext: string
  /** 文件大小（字节） */
  size: number
  /** 时长（秒，ffprobe 读取；0 表示未知） */
  duration: number
  /** 分辨率（如 1080x1920，未知为空） */
  resolution: string
  /** 修改时间 */
  mtimeMs: number
}

/**
 * 定位 Campaign 的产物根目录（与 campaign-workflow-service.getCampaignArtifactsRoot 对齐）
 */
function getCampaignArtifactsRoot(campaignId: string): string {
  const slug = `campaign-${campaignId}`
  const ws = listAgentWorkspaces().find((w) => w.slug === slug)
  if (ws?.rootPath) {
    return join(ws.rootPath, slug)
  }
  return getAgentWorkspacePath(slug)
}

/**
 * 扫描 Campaign 的 video-assets 目录，返回视频文件列表（按修改时间倒序）
 */
export async function listVideoAssets(campaignId: string): Promise<VideoAssetEntry[]> {
  const assetsDir = join(getCampaignArtifactsRoot(campaignId), 'video-assets')

  if (!existsSync(assetsDir)) {
    return []
  }

  const entries: VideoAssetEntry[] = []

  for (const fname of readdirSync(assetsDir)) {
    const ext = extname(fname).toLowerCase()
    if (!VIDEO_EXTENSIONS.has(ext)) continue

    const fullPath = resolve(assetsDir, fname)
    try {
      const st = statSync(fullPath)
      if (!st.isFile()) continue

      const { duration, resolution } = await probeVideo(fullPath)

      entries.push({
        name: fname,
        path: fullPath,
        fileUrl: pathToFileURL(fullPath).href,
        ext,
        size: st.size,
        duration,
        resolution,
        mtimeMs: st.mtimeMs,
      })
    } catch {
      // 单个文件读取失败跳过
    }
  }

  // 修改时间倒序（最新在前）
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return entries
}

/**
 * 用 ffprobe 读取视频时长与分辨率
 */
async function probeVideo(filePath: string): Promise<{ duration: number; resolution: string }> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)

  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 15000 },
    )
    const info = JSON.parse(stdout) as {
      format?: { duration?: string }
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>
    }

    const duration = info.format?.duration ? parseFloat(info.format.duration) : 0
    const videoStream = info.streams?.find((s) => s.codec_type === 'video')
    const resolution =
      videoStream?.width && videoStream?.height
        ? `${videoStream.width}x${videoStream.height}`
        : ''

    return { duration: Number.isFinite(duration) ? duration : 0, resolution }
  } catch {
    return { duration: 0, resolution: '' }
  }
}

/** 格式化文件大小（MB） */
export function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

/** 格式化时长为 mm:ss */
export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export { basename }

// ============================================================
// 写操作：删除 / 重命名
// ============================================================

/**
 * 校验路径是否位于该 Campaign 的 video-assets 目录内（防路径穿越）
 * @returns 合法的规范绝对路径，否则抛出 Error
 */
function assertInsideVideoAssets(campaignId: string, filePath: string): string {
  const assetsRoot = join(getCampaignArtifactsRoot(campaignId), 'video-assets')
  const resolved = resolve(filePath)
  if (!resolved.startsWith(assetsRoot)) {
    throw new Error('路径不在 video-assets 目录内')
  }
  return resolved
}

/**
 * 删除一个视频素材文件
 * @returns 是否删除成功
 */
export async function deleteVideoAsset(campaignId: string, filePath: string): Promise<boolean> {
  const target = assertInsideVideoAssets(campaignId, filePath)
  const { unlink } = await import('node:fs/promises')
  if (!existsSync(target)) return false
  try {
    await unlink(target)
    return true
  } catch {
    return false
  }
}

/**
 * 重命名一个视频素材文件（仅改文件名，不移动子目录）
 * @returns 新路径；文件不存在返回 null
 */
export async function renameVideoAsset(
  campaignId: string,
  filePath: string,
  newName: string,
): Promise<string | null> {
  const target = assertInsideVideoAssets(campaignId, filePath)
  const { rename } = await import('node:fs/promises')

  // 只允许重命名文件名（同一目录内），新名称去空白且不能含路径分隔符
  const clean = newName.trim()
  if (!clean || clean.includes('/') || clean.includes('\\')) {
    throw new Error('新文件名不合法')
  }
  const oldExt = extname(target)
  // 若用户没带扩展名，自动补原扩展名
  const finalName = extname(clean) ? clean : `${clean}${oldExt}`
  const newPath = join(dirname(target), finalName)

  if (!existsSync(target)) return null
  if (existsSync(newPath)) throw new Error('同名文件已存在')

  await rename(target, newPath)
  return newPath
}
