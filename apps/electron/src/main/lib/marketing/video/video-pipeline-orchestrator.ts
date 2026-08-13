/**
 * 视频生成任务编排器 — 串联分镜 → 逐镜生成 → 拼接成片
 *
 * 把 storyboard-engine（分镜）、video-generation-service（引擎调用）、
 * video-composition-service（FFmpeg 合成）串成一条可自动执行的流水线：
 *
 *   storyboard → [首帧图(可选) → 逐镜生成(受限并发/失败重试) → 下载到 raw/ ]
 *             → 拼接成片(final/) → SRT 字幕 → 完成
 *
 * 支持：
 * - 受限并发生成（避免同时打爆上游配额）
 * - 单镜失败重试（仅瞬时类错误；鉴权/超时截断不重试）
 * - 进度回调（渲染层可实时展示每个镜头状态）
 * - 产物落盘到 campaign 的 video-assets/ 目录
 */

import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import type { Storyboard, StoryboardShot } from './storyboard-engine'
import { validateStoryboard } from './storyboard-engine'
import {
  generateVideo,
  downloadVideo,
  type VideoGenerationRequest,
  type VideoEngineConfig,
} from './video-generation-service'
import {
  generateFrames,
  type FrameGeneratorConfig,
  type FrameResult,
} from './frame-generator'
import {
  composeVideo,
  generateSubtitlesFromStoryboard,
  type CompositionResult,
} from './video-composition-service'

// ============================================================
// 类型定义
// ============================================================

/** 单镜执行状态（供进度回调 / UI 展示） */
export interface ShotProgress {
  /** 镜号 */
  shotId: string
  /** 状态：pending / generating / downloading / succeeded / failed */
  status: 'pending' | 'generating' | 'downloading' | 'succeeded' | 'failed'
  /** 使用的引擎 */
  engine?: string
  /** 生成方式 */
  method?: 'text_to_video' | 'image_to_video'
  /** 已重试次数 */
  attempts: number
  /** 产物本地路径（成功后） */
  outputPath?: string
  /** 失败原因（失败后） */
  error?: string
}

/** 阶段进度回调 */
export type PipelineProgressCallback = (progress: PipelineProgress) => void

/** 整条流水线进度 */
export interface PipelineProgress {
  /** 当前阶段 */
  phase: 'storyboard' | 'generate' | 'compose' | 'done' | 'failed'
  /** 总镜头数 */
  totalShots: number
  /** 已完成镜头数（成功+失败） */
  completedShots: number
  /** 成功镜头数 */
  succeededShots: number
  /** 失败镜头数 */
  failedShots: number
  /** 每镜进度详情 */
  shots: Record<string, ShotProgress>
  /** 当前正在执行的镜头 ID 列表 */
  activeShotIds: string[]
}

/** 编排器配置 */
export interface VideoPipelineConfig {
  /** Campaign ID（决定 video-assets 落盘根目录） */
  campaignId: string
  /** Campaign 产物根目录（campaign-{id}/ 的上层，或直接用 workspace 根） */
  assetsRoot: string
  /** 分镜脚本 */
  storyboard: Storyboard
  /** 投放平台宽高比（seedance/minimax 用） */
  aspectRatio: '9:16' | '16:9' | '1:1' | '3:4'
  /** 生成引擎 */
  engine: 'seedance' | 'minimax-h3'
  /** 引擎凭据配置（渠道优先，未传则使用环境变量兜底） */
  engineConfig?: VideoEngineConfig
  /** 首帧图生成器凭据（Proma Cloud GPT Image 2，用于 image_to_video 镜头；未传则降级文生视频） */
  frameGeneratorConfig?: FrameGeneratorConfig
  /** 是否为 image_to_video 镜头生成首帧图（默认 true，无凭据自动降级） */
  generateFirstFrames?: boolean
  /** 并发上限（默认 2） */
  concurrency?: number
  /** 单镜最大重试次数（默认 2，仅瞬时错误重试） */
  maxRetries?: number
  /** 是否生成并叠加字幕（默认 true） */
  burnSubtitles?: boolean
  /** 宽高比 → 成片输出分辨率 */
  outputFormat?: '1080x1920' | '1080x1440' | '1920x1080' | '1080x1080'
  /** 进度回调 */
  onProgress?: PipelineProgressCallback
}

/** 流水线结果 */
export interface VideoPipelineResult {
  /** 是否整体成功 */
  success: boolean
  /** 成片路径（全部镜头成功且有拼接后） */
  finalVideoPath?: string
  /** 原始分镜片段路径列表 */
  rawVideoPaths: string[]
  /** 每镜结果 */
  shots: ShotProgress[]
  /** 合成结果（可选） */
  composition?: CompositionResult
  /** 失败信息（若整体失败） */
  error?: string
}

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_CONCURRENCY = 2
const DEFAULT_MAX_RETRIES = 2

/** 首帧图扩展名 → MIME 映射（转 base64 data URL 用） */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/** 首帧图 base64 data URL 映射：shotId → data URL（仅 image_to_video 镜头） */
type FirstFrameMap = Map<string, string>

// ============================================================
// 编排器实现
// ============================================================

/**
 * 执行视频生成流水线
 */
export async function runVideoPipeline(
  config: VideoPipelineConfig,
): Promise<VideoPipelineResult> {
  const progress = createInitialProgress(config.storyboard)
  const emit = (): void => config.onProgress?.(progress)

  try {
    // 0. 校验分镜
    const errors = validateStoryboard(config.storyboard)
    if (errors.length > 0) {
      return { success: false, error: errors.join('；'), rawVideoPaths: [], shots: [] }
    }

    // 1. 准备目录
    const rawDir = join(config.assetsRoot, 'video-assets', 'raw')
    const finalDir = join(config.assetsRoot, 'video-assets', 'final')
    const framesDir = join(config.assetsRoot, 'video-assets', 'frames')
    ensureDir(rawDir)
    ensureDir(finalDir)
    ensureDir(framesDir)

    // 2. 生成首帧图（可选，仅 image_to_video 镜头；无凭据自动降级文生视频）
    progress.phase = 'generate'
    emit()

    const firstFrameMap = await generateFirstFrames(config, progress, emit)

    // 3. 逐镜生成（受限并发）
    const resolvedShots = await runShotsWithConcurrency(config, firstFrameMap, progress, emit)

    const succeeded = resolvedShots.filter((s) => s.status === 'succeeded')
    const failed = resolvedShots.filter((s) => s.status === 'failed')

    progress.completedShots = resolvedShots.length
    progress.succeededShots = succeeded.length
    progress.failedShots = failed.length
    emit()

    // 3. 任一镜头失败 → 整体失败（允许 partial？这里要求全成）
    if (succeeded.length !== config.storyboard.shots.length) {
      progress.phase = 'failed'
      emit()
      return {
        success: false,
        rawVideoPaths: succeeded.map((s) => s.outputPath!).filter(Boolean),
        shots: resolvedShots,
        error: `有 ${failed.length} 个镜头生成失败：${failed.map((f) => `#${f.shotId} ${f.error ?? ''}`).join('; ')}`,
      }
    }

    // 4. 拼接成片
    progress.phase = 'compose'
    emit()

    const sortedVideos = succeeded
      .map((s) => ({ id: s.shotId, path: s.outputPath! }))
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((s) => s.path)

    const finalPath = join(finalDir, `final-${Date.now()}.mp4`)
    const composition = await composeVideo({
      inputVideos: sortedVideos,
      outputPath: finalPath,
      outputFormat: config.outputFormat
        ? { resolution: config.outputFormat }
        : undefined,
    })

    if (!composition.success) {
      progress.phase = 'failed'
      emit()
      return {
        success: false,
        rawVideoPaths: sortedVideos,
        shots: resolvedShots,
        error: `拼接失败：${composition.error ?? '未知错误'}`,
      }
    }

    // 5. 生成字幕（可选）
    if (config.burnSubtitles) {
      const srtPath = join(finalDir, `subtitles-${Date.now()}.srt`)
      try {
        await generateSubtitlesFromStoryboard(
          config.storyboard.shots.map((s) => ({
            shotId: s.shotId,
            timeRange: s.timeRange,
            subtitle: s.subtitle,
          })),
          srtPath,
        )
        // 简单 burn-in：副产物记录，但不在本次拼接阶段强依赖
      } catch {
        // 字幕失败不阻塞主流程
      }
    }

    progress.phase = 'done'
    emit()

    return {
      success: true,
      finalVideoPath: finalPath,
      rawVideoPaths: sortedVideos,
      shots: resolvedShots,
      composition,
    }
  } catch (error) {
    progress.phase = 'failed'
    emit()
    return {
      success: false,
      rawVideoPaths: [],
      shots: Object.values(progress.shots),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 创建初始进度对象 */
function createInitialProgress(storyboard: Storyboard): PipelineProgress {
  const shots: Record<string, ShotProgress> = {}
  for (const shot of storyboard.shots) {
    shots[shot.shotId] = {
      shotId: shot.shotId,
      status: 'pending',
      attempts: 0,
    }
  }
  return {
    phase: 'storyboard',
    totalShots: storyboard.shots.length,
    completedShots: 0,
    succeededShots: 0,
    failedShots: 0,
    shots,
    activeShotIds: [],
  }
}

/**
 * 为 image_to_video 镜头批量生成首帧图。
 *
 * 依赖 Proma Cloud 凭据（config.frameGeneratorConfig）：
 * - 无凭据 / 生成失败 / 读取失败 → 该镜头不写入 map，后续在 generateSingleShot 降级文生视频
 *
 * 产物落盘 video-assets/frames/，返回 base64 data URL 供视频引擎消费
 * （读本地文件转 base64，避免依赖外部图片 URL 的可达性与时效性）。
 */
async function generateFirstFrames(
  config: VideoPipelineConfig,
  _progress: PipelineProgress,
  _emit: () => void,
): Promise<FirstFrameMap> {
  const map: FirstFrameMap = new Map()
  if (config.generateFirstFrames === false) return map

  const imageShots = config.storyboard.shots.filter(
    (s) => s.generationMethod === 'image_to_video',
  )
  if (imageShots.length === 0) return map

  const fg = config.frameGeneratorConfig
  if (!fg || !fg.apiKey) return map // 无 Proma Cloud 凭据 → 全部降级文生视频

  const framesDir = join(config.assetsRoot, 'video-assets', 'frames')
  const requests = imageShots.map((s) => ({
    shotId: s.shotId,
    prompt: s.firstFramePrompt,
  }))

  let results: FrameResult[]
  try {
    results = await generateFrames(requests, framesDir, fg)
  } catch (e) {
    console.warn('[视频流水线] 首帧图生成失败，降级文生视频:', (e as Error).message)
    return map
  }

  for (const r of results) {
    if (!r.success || !r.path) continue
    try {
      const buf = readFileSync(r.path)
      const mime = MIME_BY_EXT[extname(r.path).toLowerCase()] ?? 'image/png'
      map.set(r.shotId, `data:${mime};base64,${buf.toString('base64')}`)
    } catch (e) {
      console.warn(`[视频流水线] 首帧图读取失败 ${r.shotId}:`, (e as Error).message)
    }
  }
  return map
}

/**
 * 受限并发生成所有镜头
 */
async function runShotsWithConcurrency(
  config: VideoPipelineConfig,
  firstFrameMap: FirstFrameMap,
  progress: PipelineProgress,
  emit: () => void,
): Promise<ShotProgress[]> {
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES

  const results = new Array<ShotProgress>(config.storyboard.shots.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor
      cursor += 1
      if (idx >= config.storyboard.shots.length) return
      const shot = config.storyboard.shots[idx]!

      const result = await generateSingleShot(
        config,
        shot,
        firstFrameMap.get(shot.shotId),
        maxRetries,
        idx,
        progress,
        emit,
      )
      results[idx] = result

      // 更新整体计数
      progress.completedShots = results.filter((r) => r).length
      progress.succeededShots = results.filter((r) => r?.status === 'succeeded').length
      progress.failedShots = results.filter((r) => r?.status === 'failed').length
      emit()
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, config.storyboard.shots.length) }, worker)
  await Promise.all(workers)

  return results
}

/** 生成单个镜头（含重试） */
async function generateSingleShot(
  config: VideoPipelineConfig,
  shot: StoryboardShot,
  firstFrame: string | undefined,
  maxRetries: number,
  shotIndex: number,
  progress: PipelineProgress,
  emit: () => void,
): Promise<ShotProgress> {
  // image_to_video 需首帧图；缺首帧图时自动降级为 text_to_video
  const useImageToVideo = shot.generationMethod === 'image_to_video' && !!firstFrame
  const method = useImageToVideo ? 'image_to_video' : 'text_to_video'

  const shotProgress: ShotProgress = {
    shotId: shot.shotId,
    status: 'pending',
    attempts: 0,
    method,
    engine: config.engine,
  }
  progress.shots[shot.shotId] = shotProgress
  progress.activeShotIds.push(shot.shotId)
  emit()

  const rawDir = join(config.assetsRoot, 'video-assets', 'raw')

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    shotProgress.attempts = attempt
    shotProgress.status = 'generating'
    emit()

    try {
      const request: VideoGenerationRequest = {
        prompt: shot.videoPrompt,
        engine: config.engine,
        method,
        duration: Math.max(5, Math.min(10, shot.duration)) as 5 | 10,
        aspectRatio: config.aspectRatio,
        ...(useImageToVideo && firstFrame ? { firstFrameImage: firstFrame } : {}),
      }

      const result = await generateVideo(request, config.engineConfig)

      if (result.status !== 'success' || !result.videoUrl) {
        // 鉴权错误不重试，直接失败
        throw new Error(result.error ?? '生成失败（无产物 URL）')
      }

      // 下载到本地
      shotProgress.status = 'downloading'
      emit()
      const outputPath = join(rawDir, `shot-${shot.shotId}-${Date.now()}.mp4`)
      await downloadVideo(result.videoUrl, outputPath)

      shotProgress.status = 'succeeded'
      shotProgress.outputPath = outputPath
      break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const isAuth = /401|403|invalid.*key|api.?key.*invalid|Unauthoriz/i.test(msg)
      const isTimeout = /ETIMEDOUT|超时|timeout|stall|hang|freeze|无有效数据/i.test(msg)
      // 鉴权/超时类错误不重试；其他瞬时错误才重试
      if (isAuth || isTimeout || attempt >= maxRetries) {
        shotProgress.status = 'failed'
        shotProgress.error = msg
        break
      }
      // 否则重试
    }
  }

  progress.activeShotIds = progress.activeShotIds.filter((id) => id !== shot.shotId)
  return shotProgress
}

/** 确保目录存在 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}
