import { describe, expect, test } from 'bun:test'
import { resolveSubAgentContextOptions } from './subagent-context-options'

describe('SubAgent TCC context options', () => {
  test('旧调用保持 plain-text 和非 TCC 隔离语义', () => {
    expect(resolveSubAgentContextOptions()).toEqual({ resultProtocol: 'plain-text', readOnly: false })
  })

  test('显式 projection 默认收紧为 typed-v1 和只读', () => {
    const projection = {
      sessionId: 'session-1',
      purpose: 'subagent_spawn' as const,
      task: '探索调用边界',
    }
    expect(resolveSubAgentContextOptions({ projection })).toEqual({
      projection,
      resultProtocol: 'typed-v1',
      readOnly: true,
    })
  })

  test('调用方可显式声明协议与写入意图，供后续 permission 边界验证', () => {
    expect(resolveSubAgentContextOptions({ resultProtocol: 'plain-text', readOnly: false })).toEqual({
      resultProtocol: 'plain-text',
      readOnly: false,
    })
  })
})
