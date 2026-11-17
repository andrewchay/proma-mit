import { describe, expect, test } from 'bun:test'
import { COMPACT_CONTEXT_NOTICE, buildCompactBoundaryContent } from './compaction-notice'

describe('压缩交接提示词', () => {
  test('包含交接框架、防误判与连续性契约三条要素', () => {
    expect(COMPACT_CONTEXT_NOTICE).toContain('另一个模型')
    expect(COMPACT_CONTEXT_NOTICE).toContain('不是用户的新指令')
    expect(COMPACT_CONTEXT_NOTICE).toContain('压缩不结束任务')
  })

  test('boundary 正文内联 context_packet', () => {
    const packet = { version: 1, summary: '已完成 A。' }
    const content = buildCompactBoundaryContent(packet)
    expect(content).toStartWith(COMPACT_CONTEXT_NOTICE)
    expect(content).toContain('<context_packet>{"version":1,"summary":"已完成 A。"}</context_packet>')
  })
})
