import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { openTrace } from './trace-writer'
import { getEvalTracePath } from '../../config-paths'

const testDir = join(tmpdir(), `gravitas-trace-${Date.now()}`)

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
})

describe('trace-writer', () => {
  it('openTrace 写入元信息 + 逐条 append SDKMessage，close 后可读', () => {
    const runId = 'run-abc'
    const w = openTrace({
      runId,
      benchmarkId: 'b1',
      caseId: 'CASE-001',
      run: 1,
      agentVersion: 2,
      model: 'deepseek-v4-flash',
      systemPrompt: '审查指令',
      createdAt: '2026-08-17T00:00:00Z',
    })
    // 模拟 SDKMessage（含 tool_use / tool_result 决策序列）
    w.append({ type: 'assistant', message: { content: [{ type: 'text', text: '分析中' }] }, session_id: runId })
    w.append({ type: 'user', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.js' } }] }, session_id: runId })
    w.append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file content', is_error: false }] }, session_id: runId })
    w.appendRaw({ note: '评测运行失败原因' })
    const sizeBefore = w.size()
    w.close()

    const tracePath = getEvalTracePath(runId)
    expect(tracePath).toBe(w.tracePath)
    expect(existsSync(tracePath)).toBe(true)
    // 1 meta + 4 entries
    expect(sizeBefore).toBe(5)

    const lines = readFileSync(tracePath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(5)
    const meta = JSON.parse(lines[0]!)
    expect(meta.type).toBe('__meta')
    expect(meta.runId).toBe(runId)
    expect(meta.benchmarkId).toBe('b1')
    // 含 tool_use 决策序列
    const blob = lines.join('\n')
    expect(blob).toContain('"name":"Read"')
    expect(blob).toContain('"tool_use_id":"t1"')
    expect(blob).toContain('raw')
  })

  it('不同 runId 写不同 trace 文件（隔离）', () => {
    const a = openTrace({ runId: 'run-A', benchmarkId: 'b', caseId: 'c', run: 1, agentVersion: 1, createdAt: '' })
    a.append({ type: 'assistant', session_id: 'run-A' })
    a.close()
    const b = openTrace({ runId: 'run-B', benchmarkId: 'b', caseId: 'c', run: 1, agentVersion: 1, createdAt: '' })
    b.append({ type: 'assistant', session_id: 'run-B' })
    b.close()

    expect(existsSync(getEvalTracePath('run-A'))).toBe(true)
    expect(existsSync(getEvalTracePath('run-B'))).toBe(true)
    expect(getEvalTracePath('run-A')).not.toBe(getEvalTracePath('run-B'))
  })

  it('append 环形数据不回崩（大小写/裁剪鲁棒）', () => {
    const w = openTrace({ runId: 'run-cyclic', benchmarkId: 'b', caseId: 'c', run: 1, agentVersion: 1, createdAt: '' })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => w.append(cyclic)).not.toThrow() // JSON.stringify 循环会 fallback String
    w.close()
  })
})
