import { describe, expect, test } from 'bun:test'
import { parseContextPacket } from './context-compaction'

describe('ContextPacket', () => {
  test('只接受包含可审阅字段的 v1 JSON 压缩结果', () => {
    expect(parseContextPacket(JSON.stringify({
      version: 1,
      summary: '用户正在修复 Gravitas 的上下文压缩。',
      facts: ['当前模型为 kimi-k3。'],
      decisions: ['K3 上下文窗口按 1M 处理。'],
      openTasks: ['实现 ContextPacket。'],
      importantFiles: ['apps/electron/src/main/lib/agent-runtime/context-compaction.ts'],
      toolState: ['未执行外部写入。'],
    }))).toEqual({
      version: 1,
      summary: '用户正在修复 Gravitas 的上下文压缩。',
      facts: ['当前模型为 kimi-k3。'],
      decisions: ['K3 上下文窗口按 1M 处理。'],
      openTasks: ['实现 ContextPacket。'],
      importantFiles: ['apps/electron/src/main/lib/agent-runtime/context-compaction.ts'],
      toolState: ['未执行外部写入。'],
    })
  })

  test("缺少任一审阅字段时拒绝压缩包", () => {
    expect(parseContextPacket(JSON.stringify({
      version: 1,
      summary: "不完整的压缩结果。",
      facts: [],
      decisions: [],
      openTasks: [],
      importantFiles: [],
    }))).toBeUndefined()
  })
})
