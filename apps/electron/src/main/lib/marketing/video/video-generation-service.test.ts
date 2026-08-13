import { describe, test, expect } from 'bun:test'
import { buildSeedanceContent, type VideoGenerationRequest } from './video-generation-service'

/**
 * video-generation-service 单元测试
 *
 * 覆盖 Seedance content 组装逻辑（image_to_video 首帧图）：
 *  - 文生视频仅含 text（提示词 + --ratio/--fps/--resolution/--duration 参数）
 *  - 图生视频在 text 后追加 image_url 首帧图（支持 base64 data URL 与公网 URL）
 *  - 图生视频缺首帧图时降级为仅 text（由上层保证降级）
 */

function baseRequest(overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest {
  return {
    prompt: '产品展示',
    engine: 'seedance',
    method: 'text_to_video',
    duration: 5,
    aspectRatio: '9:16',
    ...overrides,
  }
}

describe('buildSeedanceContent', () => {
  test('文生视频仅含 text content，且携带生成参数', () => {
    const content = buildSeedanceContent(baseRequest())
    expect(content).toHaveLength(1)
    expect(content[0]?.type).toBe('text')
    const text = content[0]?.text ?? ''
    expect(text).toContain('产品展示')
    expect(text).toContain('--ratio 9:16')
    expect(text).toContain('--fps 24')
    expect(text).toContain('--resolution 720p')
    expect(text).toContain('--duration 5')
  })

  test('图生视频追加 image_url 首帧图（base64 data URL）', () => {
    const content = buildSeedanceContent(
      baseRequest({ method: 'image_to_video', firstFrameImage: 'data:image/png;base64,AAAA' }),
    )
    expect(content).toHaveLength(2)
    expect(content[0]?.type).toBe('text')
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    })
  })

  test('图生视频支持公网 URL 首帧图', () => {
    const content = buildSeedanceContent(
      baseRequest({ method: 'image_to_video', firstFrameImage: 'https://example.com/frame.png' }),
    )
    expect(content).toHaveLength(2)
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.com/frame.png' },
    })
  })

  test('图生视频缺首帧图时降级为仅 text', () => {
    const content = buildSeedanceContent(baseRequest({ method: 'image_to_video' }))
    expect(content).toHaveLength(1)
    expect(content[0]?.type).toBe('text')
  })
})
