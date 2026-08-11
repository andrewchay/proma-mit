/**
 * 创意素材 — 视频生成服务
 *
 * 封装 ma-proma 迁移来的纯逻辑视频模块（marketing/video/）：
 *   - generateCreativeStoryboard 分镜脚本生成（纯本地，无需 API）
 *   - runCreativeVideoPipeline    完整流水线（分镜→多镜生成→拼接成片）
 *   - probeVideoAsset             ffprobe 读取视频元数据
 *
 * 视频引擎（Seedance/MiniMax）与首帧图（Proma Cloud GPT Image-2）的
 * 凭据从 process.env 读取，未配置时抛明确错误或回退。
 */
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  generateStoryboard,
  runVideoPipeline,
  getVideoInfo,
  renderFinalVideo,
  type VideoInput,
  type VideoPipelineConfig,
  type VideoPipelineResult,
  type Storyboard,
} from './video'

// ============================================================
// 分镜生成
// ============================================================

/** 生成广告视频分镜（纯本地模板+规则，不消耗 LLM/视频 API） */
export function generateCreativeStoryboard(input: VideoInput): Storyboard {
  return generateStoryboard(input)
}

// ============================================================
// 视频生成流水线
// ============================================================

export interface CreativeVideoPipelineOptions {
  /** 产物根目录（video-assets/ 的上层） */
  assetsRoot: string
  /** 分镜脚本（可由 generateCreativeStoryboard 生成） */
  storyboard: Storyboard
  /** 投放平台宽高比 */
  aspectRatio: '9:16' | '16:9' | '1:1' | '3:4'
  /** 生成引擎（默认 seedance） */
  engine?: 'seedance' | 'minimax-h3'
  /** 并发上限（默认 2） */
  concurrency?: number
  /** 是否字幕 burn-in（默认 true） */
  burnSubtitles?: boolean
  /** 成片分辨率（默认 1080x1920） */
  outputFormat?: '1080x1920' | '1080x1440' | '1920x1080' | '1080x1080'
  /** 进度回调 */
  onProgress?: VideoPipelineConfig['onProgress']
}

/**
 * 运行完整视频生成流水线。
 * 产物落盘到 {assetsRoot}/video-assets/{raw,final,frames}。
 */
export async function runCreativeVideoPipeline(
  options: CreativeVideoPipelineOptions,
): Promise<VideoPipelineResult> {
  ensureVideoCredential()
  ensureVideoAssetsDirs(options.assetsRoot)

  const config: VideoPipelineConfig = {
    campaignId: 'creative',
    assetsRoot: options.assetsRoot,
    storyboard: options.storyboard,
    aspectRatio: options.aspectRatio,
    engine: options.engine ?? 'seedance',
    concurrency: options.concurrency ?? 2,
    burnSubtitles: options.burnSubtitles ?? true,
    outputFormat: options.outputFormat ?? '1080x1920',
    onProgress: options.onProgress,
  }
  return runVideoPipeline(config)
}

// ============================================================
// 元数据探测
// ============================================================

/** 用 ffprobe 读取视频文件的时长/分辨率 */
export async function probeVideoAsset(videoPath: string) {
  const info = await getVideoInfo(videoPath)
  return {
    duration: info.duration,
    resolution: info.resolution,
    fileSize: info.fileSize,
    bitrate: info.bitrate,
  }
}

// ============================================================
// 落盘目录 + 凭据校验
// ============================================================

/** 确保 video-assets 子目录存在 */
export function ensureVideoAssetsDirs(assetsRoot: string): void {
  for (const sub of ['raw', 'final', 'frames']) {
    const dir = join(assetsRoot, 'video-assets', sub)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

/** 校验视频引擎凭据是否可用 */
export function ensureVideoCredential(engine: 'seedance' | 'minimax-h3' = 'seedance'): void {
  if (engine === 'minimax-h3') {
    if (!process.env.MINIMAX_API_KEY) {
      throw new Error('未配置 MINIMAX_API_KEY，无法调用 MiniMax H3 视频引擎')
    }
    return
  }
  if (!process.env.VOLCENGINE_API_KEY) {
    throw new Error('未配置 VOLCENGINE_API_KEY，无法调用 Seedance 视频引擎')
  }
}

export { renderFinalVideo }
