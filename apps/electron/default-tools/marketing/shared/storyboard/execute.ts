/**
 * 营销视频分镜生成工具（目录化版本）
 *
 * 纯本地、零 electron 依赖，可顶层构造 / 测试可执行。
 */

import {
  generateStoryboard,
  type Storyboard,
  type VideoInput,
} from '../../../marketing/video/storyboard-engine'

export async function execute(input: unknown): Promise<string> {
  const args = (input ?? {}) as Record<string, unknown>
  const product = String(args.product ?? '').trim()
  const category = String(args.category ?? '').trim()
  const platform = String(args.platform ?? '').trim()
  const textInput = String(args.text_input ?? '').trim()

  if (!product || !category || !platform || !textInput) {
    return '参数缺失: product、category、platform、text_input 为必填项'
  }

  const sellingPoints = typeof args.selling_points === 'string'
    ? args.selling_points.split(',').map((s) => s.trim()).filter(Boolean)
    : []

  const videoInput: VideoInput = {
    product,
    category,
    sellingPoints,
    targetAudience: String(args.target_audience ?? ''),
    platform: platform as VideoInput['platform'],
    duration: typeof args.duration === 'number' ? args.duration : 30,
    style: typeof args.style === 'string' ? args.style : undefined,
    textInput,
  }

  const storyboard: Storyboard = generateStoryboard(videoInput)

  const lines = [
    `# ${product} 广告分镜脚本（${storyboard.totalShots} 镜 · ${storyboard.totalDuration}s）`,
    `创意方向: ${storyboard.creativeDirection}`,
    `推荐引擎: ${storyboard.recommendedEngine}`,
    '',
    ...storyboard.shots.map((shot) => [
      `--- 镜 ${shot.shotId} [${shot.timeRange}] ---`,
      `场景: ${shot.scene}`,
      `画面: ${shot.visualDescription}`,
      `镜头运动: ${shot.camera}`,
      `旁白: ${shot.narration}`,
      `字幕: ${shot.subtitle}`,
      `生成方式: ${shot.generationMethod}`,
      `首帧提示词: ${shot.firstFramePrompt}`,
      `视频提示词: ${shot.videoPrompt}`,
    ].join('\n')),
  ].join('\n')

  return lines
}
