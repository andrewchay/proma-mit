/**
 * 广告视频生成模块出口
 *
 * 提供视频创意分镜、引擎调用、后期合成三大能力：
 * - storyboard-engine       分镜脚本生成引擎
 * - video-generation-service 视频生成 API 封装（Seedance / MiniMax H3）
 * - video-composition-service FFmpeg 后期合成管道
 */

export * from './storyboard-engine'
export * from './video-generation-service'
export * from './video-composition-service'
export * from './video-pipeline-orchestrator'
export * from './frame-generator'
