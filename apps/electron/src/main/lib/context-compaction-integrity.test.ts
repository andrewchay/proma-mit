/**
 * C01/C02：压缩 Golden 链、boundary 原文定位与归档完整性。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { buildElectronMock } from './testing/electron-mock'
import type { SDKMessage } from '@gravitas/shared'

const tempHomeDir = mkdtempSync(join(tmpdir(), 'gravitas-compact-integrity-'))
process.env.PROMA_DEV = '1'
mock.module('os', () => ({ homedir: () => tempHomeDir, tmpdir }))
mock.module('electron', () => buildElectronMock())

const { createAgentSession, compactSDKMessages, getAgentSessionSDKMessages, assessCompactionArchiveIntegrity } = await import('./agent-session-manager')
const { getConfigDir } = await import('./config-paths')
const { createAgentWorkspace, getAgentWorkspacePath } = await import('./agent-workspace-manager')
const { CONTEXT_COMPACTION_GOLDENS } = await import('./agent-runtime/context-compaction-goldens')
const { evaluateContextCompactionGoldenSet, evaluateContextPacket } = await import('./agent-runtime/context-compaction-evaluator')

afterAll(() => { rmSync(tempHomeDir, { recursive: true, force: true }) })

let workspaceId = ''
let workspaceSlug = ''
beforeEach(() => {
  const ws = createAgentWorkspace(`Compact Integrity ${Date.now()}`)
  workspaceId = ws.id
  workspaceSlug = ws.slug
})

const msg = (text: string): SDKMessage => ({ type: 'user', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null }) as unknown as SDKMessage

const seedHistory = (sessionId: string, messages: SDKMessage[]): void => {
  const dir = join(getConfigDir(), 'agent-sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), messages.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8')
}

describe('C01 Golden 链', () => {
  test('全部 golden 通过评估，含三连压缩样本（目标/决策/待办保留）', () => {
    const result = evaluateContextCompactionGoldenSet(CONTEXT_COMPACTION_GOLDENS)
    expect(result.passed).toBe(true)
    expect(CONTEXT_COMPACTION_GOLDENS.some((f) => f.golden.id === 'triple-compaction-chain')).toBe(true)
  })
  test('丢失必需事实/决策/待办的摘要被评估拦截（零容忍）', () => {
    const golden = { id: 'neg', requiredFacts: ['Kimi K3'], requiredDecisions: ['ContextPacket v1'], requiredOpenTasks: ['P5'] }
    const bad = evaluateContextPacket({ version: 1, summary: 'x', facts: ['无关'], decisions: [], openTasks: ['P5 已提'], importantFiles: [], toolState: [] }, golden)
    expect(bad.passed).toBe(false)
    expect(bad.missing).toContain('facts:Kimi K3')
    expect(bad.missing).toContain('decisions:ContextPacket v1')
  })
})

describe('C02 boundary 原文定位与归档完整性', () => {
  test('boundary 携带压缩前消息数、SHA-256 摘要与归档文件名', () => {
    const session = createAgentSession('integrity', undefined, workspaceId, undefined, 'pi')
    const history = [msg('甲'), msg('乙'), msg('丙'), msg('丁')]
    seedHistory(session.id, history)
    const result = compactSDKMessages(session.id, '摘要', 2)
    const boundary = result[0] as unknown as { subtype?: string; compactionSource?: { messageCount: number; sha256: string; archiveFile?: string } }
    expect(boundary.subtype).toBe('compact_boundary')
    expect(boundary.compactionSource).toBeDefined()
    expect(boundary.compactionSource!.messageCount).toBe(2)
    const expected = createHash('sha256').update(history.slice(0, 2).map((m) => JSON.stringify(m)).join('\n'), 'utf8').digest('hex')
    expect(boundary.compactionSource!.sha256).toBe(expected)
    expect(boundary.compactionSource!.archiveFile).toBeTruthy()
    const archiveDir = join(getConfigDir(), 'agent-sessions', 'compaction-archive', session.id)
    expect(readFileSync(join(archiveDir, boundary.compactionSource!.archiveFile!), 'utf8')).toContain('甲')
  })
  test('归档完整性：无压缩→no_compaction；有归档→ok；归档缺失→unrecoverable', () => {
    const fresh = createAgentSession('fresh', undefined, workspaceId, undefined, 'pi')
    expect(assessCompactionArchiveIntegrity(fresh.id).status).toBe('no_compaction')

    const session = createAgentSession('archived', undefined, workspaceId, undefined, 'pi')
    seedHistory(session.id, [msg('一'), msg('二'), msg('三')])
    compactSDKMessages(session.id, '摘要', 1)
    expect(assessCompactionArchiveIntegrity(session.id).status).toBe('ok')

    rmSync(join(getConfigDir(), 'agent-sessions', 'compaction-archive', session.id), { recursive: true, force: true })
    const broken = assessCompactionArchiveIntegrity(session.id)
    expect(broken.status).toBe('unrecoverable')
    expect(broken.reason).toContain('不可恢复')
  })
  test('压缩后历史 = boundary + 配对完整的最近段', () => {
    const session = createAgentSession('pairs', undefined, workspaceId, undefined, 'pi')
    const pair: SDKMessage[] = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: {} }] }, parent_tool_use_id: null },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] }, parent_tool_use_id: 'c1' },
    ] as unknown as SDKMessage[]
    seedHistory(session.id, [msg('早1'), msg('早2'), msg('早3'), ...pair])
    const result = compactSDKMessages(session.id, '摘要', 1)
    // keepRecent=1 的切片点落在 tool_result 上，应回退到配对的 assistant
    const kept = result.filter((m) => m.type !== 'system')
    expect(kept).toHaveLength(2)
    expect(JSON.stringify(kept[0])).toContain('tool_use')
    // 当前文件中 boundary 之后无孤儿 tool_result 开头
    expect(assessCompactionArchiveIntegrity(session.id).status).toBe('ok')
  })
})
