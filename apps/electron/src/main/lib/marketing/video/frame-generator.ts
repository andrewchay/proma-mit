/**
 * 分镜首帧图生成器 — 为图生视频生成画面首帧
 *
 * 用 Proma Cloud 的 GPT Image 2 能力，为 storyboard 中每个镜头的
 * `firstFramePrompt` 生成一张首帧图，保存到 `video-assets/frames/`，
 * 供后续 `image_to_video` 作为图生视频的起始画面，提升镜间一致性。
 *
 * 完全复用 proma-gpt-image-2 的接口约定：
 *   POST {API_ROOT}/api/v1/tools/gpt-image-2/generate
 * 其中 API_ROOT = baseUrl 归一化到根域名。
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

/** 首帧图生成结果 */
export interface FrameResult {
  /** 镜号 */
  shotId: string
  /** 首帧图本地路径 */
  path: string
  /** 首帧图 URL（可回传引擎） */
  url: string
  /** 是否成功 */
  success: boolean
  /** 失败原因（可选） */
  error?: string
}

/** 待生成的首帧请求 */
export interface FrameRequest {
  shotId: string
  /** 首帧提示词 */
  prompt: string
  /** 尺寸（可选，默认 1024x1024） */
  size?: string
  /** 质量（可选，默认 medium） */
  quality?: 'low' | 'medium' | 'high'
}

/** 生成器配置 */
export interface FrameGeneratorConfig {
  /** Proma Cloud API Key */
  apiKey: string
  /** Proma Cloud baseUrl（可带 /api/v1 后缀，会自动归一化） */
  baseUrl: string
  /** 并发上限（默认 2） */
  concurrency?: number
}

/** 归一化 baseUrl 到根域名 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/api\/v1\/?$/, '')
}

/**
 * 批量生成首帧图
 * @param requests 首帧请求列表
 * @param framesDir 保存目录（video-assets/frames）
 * @param config 凭据配置
 */
export async function generateFrames(
  requests: FrameRequest[],
  framesDir: string,
  config: FrameGeneratorConfig,
): Promise<FrameResult[]> {
  if (!existsSync(framesDir)) mkdirSync(framesDir, { recursive: true })

  const concurrency = config.concurrency ?? 2
  const results = new Array<FrameResult>(requests.length)
  const apiRoot = normalizeBaseUrl(config.baseUrl)
  let cursor = 0

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor
      cursor += 1
      if (idx >= requests.length) return
      const req = requests[idx]!
      try {
        const res = await fetch(`${apiRoot}/api/v1/tools/gpt-image-2/generate`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt: req.prompt,
            size: req.size ?? '1024x1024',
            quality: req.quality ?? 'medium',
          }),
        })

        if (!res.ok) {
          const errText = await res.text()
          results[idx] = {
            shotId: req.shotId,
            path: '',
            url: '',
            success: false,
            error: `HTTP ${res.status}: ${errText.slice(0, 200)}`,
          }
          continue
        }

        const data = await res.json() as { images?: string[] }
        const imageUrl = data.images?.[0]
        if (!imageUrl) {
          results[idx] = {
            shotId: req.shotId,
            path: '',
            url: '',
            success: false,
            error: '响应中无 images[0]',
          }
          continue
        }

        // 下载图片并保存
        const imgRes = await fetch(imageUrl)
        if (!imgRes.ok) throw new Error(`下载首帧失败 HTTP ${imgRes.status}`)
        const buf = Buffer.from(await imgRes.arrayBuffer())
        const ext = extname(new URL(imageUrl).pathname) || '.png'
        const fileName = `frame-${req.shotId}-${Date.now()}${ext}`
        const filePath = join(framesDir, fileName)
        writeFileSync(filePath, buf)

        results[idx] = {
          shotId: req.shotId,
          path: filePath,
          url: imageUrl,
          success: true,
        }
      } catch (e) {
        results[idx] = {
          shotId: req.shotId,
          path: '',
          url: '',
          success: false,
          error: e instanceof Error ? e.message : String(e),
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, requests.length) }, worker)
  await Promise.all(workers)
  return results
}
