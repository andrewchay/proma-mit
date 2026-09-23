import { describe, expect, test } from 'bun:test'
import type {
  ContextItem,
  ContextProjectionRequest,
  SubtaskResult,
} from './index'

describe('Typed Context Compiler 共享契约', () => {
  test('ContextItem 可表达可追溯、可验证的工具观察', () => {
    const item: ContextItem = {
      id: 'ctx-tool-1',
      kind: 'tool_observation',
      version: 1,
      createdAt: '2026-09-22T07:40:00.000Z',
      updatedAt: '2026-09-22T07:40:00.000Z',
      content: '已读取 apps/electron/src/main/lib/agent-runtime/context-compaction.ts。',
      summary: '读取了上下文压缩模块。',
      tags: ['context-compaction'],
      visibility: 'model',
      mutability: 'append_only',
      confidence: 'high',
      source: {
        kind: 'tool_result',
        id: 'tool-call-1',
        sessionId: 'session-1',
      },
      evidence: [{
        kind: 'tool_result',
        sourceId: 'tool-call-1',
        locator: 'Read',
        verified: true,
      }],
    }

    expect(item.source.id).toBe('tool-call-1')
    expect(item.evidence[0]?.verified).toBe(true)
  })

  test('projection 请求将用途、预算和策略显式化', () => {
    const request: ContextProjectionRequest = {
      sessionId: 'session-1',
      purpose: 'subagent_spawn',
      task: '定位上下文压缩的入口文件。',
      maxInputTokens: 4_000,
      requiredKinds: ['file_fact', 'tool_observation'],
      policy: {
        allowUnverified: false,
        includeRawEvidence: true,
        includeSummaries: true,
        includeFullContent: false,
      },
    }

    expect(request.purpose).toBe('subagent_spawn')
    expect(request.policy?.allowUnverified).toBe(false)
  })

  test('SubtaskResult 分离已验证主张和未验证事项', () => {
    const result: SubtaskResult = {
      protocolVersion: 1,
      taskId: 'subtask-1',
      status: 'partial',
      summary: '已找到主入口，尚未确认所有调用点。',
      claims: [{
        statement: 'context-compaction.ts 提供自动压缩入口。',
        confidence: 'high',
        verified: true,
        evidence: [{
          kind: 'file_locator',
          sourceId: 'file-read-1',
          locator: 'apps/electron/src/main/lib/agent-runtime/context-compaction.ts',
          verified: true,
        }],
      }],
      artifacts: [],
      unverified: ['尚未检查 Pi runtime 的所有调用点。'],
      recommendedNextSteps: ['搜索 compactSDKMessages 的调用。'],
    }

    expect(result.status).toBe('partial')
    expect(result.unverified).toHaveLength(1)
  })
})
