/**
 * 创意素材 — 视频生成服务
 *
 * 封装 ma-proma 迁移来的纯逻辑视频模块（marketing/video/）：
 *   - generateCreativeStoryboard 分镜脚本生成（纯本地，无需 API）
 *   - runCreativeVideoPipeline    完整流水线（分镜→多镜生成→拼接成片）
 *   - probeVideoAsset             ffprobe 读取视频元数据
 *
 * 视频引擎（Seedance/MiniMax）凭据优先从「模型配置页」渠道解析
 * （seedance→doubao 渠道、minimax-h3→minimax 渠道），
 * 未配置渠道时回退到 process.env.VOLCENGINE_API_KEY / MINIMAX_API_KEY。
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
  type FrameGeneratorConfig,
} from './video'
import { resolveVideoEngineConfig } from './video/video-credential-resolver'

/** Proma Cloud（首帧图 GPT Image 2）默认 API 根地址 */
const PROMA_CLOUD_DEFAULT_BASE_URL = 'https://api.proma.cool'

/** 解析首帧图生成器凭据；未配置 PROMA_CLOUD_API_KEY 时返回 undefined（image_to_video 镜头降级文生视频） */
function resolveFrameGeneratorConfig(): FrameGeneratorConfig | undefined {
  const apiKey = process.env.PROMA_CLOUD_API_KEY?.trim()
  if (!apiKey) return undefined
  return {
    apiKey,
    baseUrl: process.env.PROMA_CLOUD_BASE_URL?.trim() || PROMA_CLOUD_DEFAULT_BASE_URL,
  }
}

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
  /** 显式指定引擎渠道 ID（默认自动选择该引擎首个可用渠道） */
  engineChannelId?: string
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
 *
 * 凭据解析：优先引擎渠道（seedance→doubao、minimax-h3→minimax），
 * 可通过 engineChannelId 指定渠道；未配置渠道时回退环境变量。
 */
export async function runCreativeVideoPipeline(
  options: CreativeVideoPipelineOptions,
): Promise<VideoPipelineResult> {
  const engine = options.engine ?? 'seedance'
  const engineConfig = resolveVideoEngineConfig(engine, options.engineChannelId)

  if (options.engineChannelId && engineConfig.source !== 'channel') {
    // 显式指定了渠道但未能命中（禁用 / 无 Key / 解密失败）
    return {
      success: false,
      rawVideoPaths: [],
      shots: [],
      error: `指定渠道 ${options.engineChannelId} 不可用（已禁用或未配置 API Key），或不存在对应 ${engine} 渠道`,
    }
  }

  if (!engineConfig.apiKey) {
    return {
      success: false,
      rawVideoPaths: [],
      shots: [],
      error: engine === 'minimax-h3'
        ? '未找到可用的 minimax 渠道（或在环境变量中配置 MINIMAX_API_KEY）'
        : '未找到可用的 doubao 渠道（或在环境变量中配置 VOLCENGINE_API_KEY）',
    }
  }

  ensureVideoAssetsDirs(options.assetsRoot)

  const config: VideoPipelineConfig = {
    campaignId: 'creative',
    assetsRoot: options.assetsRoot,
    storyboard: options.storyboard,
    aspectRatio: options.aspectRatio,
    engine,
    engineConfig,
    frameGeneratorConfig: resolveFrameGeneratorConfig(),
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

/**
 * 校验视频引擎凭据是否可用（渠道优先，环境变量兜底）。
 * 无可用凭据时抛出明确错误。
 */
export function ensureVideoCredential(engine: 'seedance' | 'minimax-h3' = 'seedance'): void {
  const cfg = resolveVideoEngineConfig(engine)
  if (!cfg.apiKey) {
    if (engine === 'minimax-h3') {
      throw new Error('未配置 MINIMAX_API_KEY 或 minimax 渠道，无法调用 MiniMax H3 视频引擎')
    }
    throw new Error('未配置 VOLCENGINE_API_KEY 或 doubao 渠道，无法调用 Seedance 视频引擎')
  }
}

/**
 * 解析视频引擎凭据（渠道优先，环境变量兜底），返回来源信息供 UI/Agent 展示。
 */
export function resolveVideoCredential(engine: 'seedance' | 'minimax-h3' = 'seedance') {
  const cfg = resolveVideoEngineConfig(engine)
  return {
    ok: !!cfg.apiKey,
    source: cfg.apiKey ? cfg.source : null,
    channelId: cfg.channelId,
    channelName: cfg.channelName,
    engine,
  }
}

export { renderFinalVideo }
