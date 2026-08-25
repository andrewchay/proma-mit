/**
 * EvidenceService 单元测试
 */

import { describe, test, expect, afterAll, mock } from 'bun:test'
import { buildElectronMock } from './testing/electron-mock'
import { mkdirSync, rmSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import type { TokenUsageRecord, TokenUsageQuery } from '@gravitas/shared'

// 覆盖 os 与 electron，避免 import 链（token-usage-service → agent-session-manager）拉入真实依赖
const originalHomedir = homedir()
const tempHomeDir = mkdtempSync(join(tmpdir(), 'proma-evidence-test-'))

mock.module('os', () => ({
  homedir: () => tempHomeDir,
  tmpdir,
}))

mock.module('electron', () => buildElectronMock())

const { buildSessionEvidence, formatEvidenceSummary } = await import('./evidence-service')

function sampleRecordSource(query: TokenUsageQuery): TokenUsageRecord[] {
  void query
  return [
    {
      id: 'r1',
      sessionId: 'session-1',
      turnIndex: 1,
      timestamp: Date.now(),
      modelId: 'deepseek-v4-flash',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 1200,
      costInput: 0.001,
      costOutput: 0.002,
      costCacheRead: 0,
      costCacheCreation: 0,
      costTotal: 0.003,
      toolNames: ['Read', 'Write', 'Bash', 'mcp__mem__recall_memory'],
      skillIds: ['growth-scout'],
      mcpServers: ['mem'],
      sessionTitle: '测试会话',
    },
    {
      id: 'r2',
      sessionId: 'session-1',
      turnIndex: 2,
      timestamp: Date.now(),
      modelId: 'deepseek-v4-flash',
      inputTokens: 500,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 600,
      costInput: 0.0005,
      costOutput: 0.001,
      costCacheRead: 0,
      costCacheCreation: 0,
      costTotal: 0.0015,
      toolNames: ['Edit', 'Grep'],
      skillIds: [],
      mcpServers: [],
      sessionTitle: '测试会话',
    },
  ]
}

afterAll(() => {
  if (existsSync(tempHomeDir)) rmSync(tempHomeDir, { recursive: true, force: true })
  mock.module('os', () => ({
    homedir: () => originalHomedir,
    tmpdir,
  }))
})

describe('EvidenceService', () => {
  test('buildSessionEvidence 生成结构化证据', () => {
    const evidence = buildSessionEvidence('session-1', 'completed', '实现一个功能', sampleRecordSource)

    expect(evidence).toBeDefined()
    expect(evidence.validation).toContain('运行成功完成')
    expect(evidence.writeback).toBeDefined()
    expect(evidence.writeback).toContain('Write')
    expect(evidence.writeback).toContain('Edit')
    expect(evidence.evidence).toContain('2 轮')
    expect(evidence.evidence).toContain('1,800 tokens')
    expect(evidence.evidence).toContain('运行成功')
    expect(evidence.decisions).toBeDefined()
  })

  test('failed 状态 validation 标记失败', () => {
    const evidence = buildSessionEvidence('session-1', 'failed', undefined, sampleRecordSource)
    expect(evidence.validation).toContain('运行失败')
    expect(evidence.evidence).toContain('运行失败')
  })

  test('formatEvidenceSummary 生成可读摘要', () => {
    const evidence = buildSessionEvidence('session-1', 'completed', undefined, sampleRecordSource)
    const summary = formatEvidenceSummary(evidence)
    expect(summary).toContain('运行成功完成')
    expect(summary).toContain('改动了')
  })
})
