/**
 * C03：session lesson → candidate → 既有 Approval → approved 写入 的链路钉板。
 * 敏感候选在进入审批链前拦截；批准才写入；重复批准幂等；拒绝不写入。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'gravitas-memory-chain-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir
mock.module('electron', () => buildElectronMock())

const { createMemoryApproval, approveApproval, rejectApproval, getPendingApprovals, setApprovedChangeExecutor } = await import('./approval-service')
const { executeApprovedChange } = await import('./proactive-approved-change-executor')
const { extractMemoryCandidatesFromOutput, containsSensitiveContent, listMemoryItems } = await import('./memory-plugin-service')

afterAll(() => {
  setApprovedChangeExecutor(async () => {})
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(join(configDir, 'proactive'), { recursive: true, force: true })
  rmSync(join(configDir, 'plugins'), { recursive: true, force: true })
  setApprovedChangeExecutor((approval) => executeApprovedChange(approval, { createSchedule: () => {} }))
})

const memoryBlock = (items: unknown[]) => '```proma-memory-items\n' + JSON.stringify({ items }) + '\n```'

describe('C03 记忆治理链', () => {
  test('候选 → 审批 → 批准后才写入；重复批准幂等不产生第二条', async () => {
    const candidates = extractMemoryCandidatesFromOutput(memoryBlock([{ title: '偏好中文回复', content: '用户要求中文', kind: 'preference' }]), 'run-1', 'sess-1')
    expect(candidates).toHaveLength(1)
    expect(listMemoryItems().filter((i) => i.title === '偏好中文回复')).toHaveLength(0)

    const approval = createMemoryApproval('run-1', candidates[0]!.title, candidates[0]!.content, { kind: candidates[0]!.kind })
    expect(approval.status).toBe('pending')
    expect(listMemoryItems().filter((i) => i.title === '偏好中文回复')).toHaveLength(0)

    const approved = await approveApproval(approval.id)
    expect(approved?.status).toBe('approved')
    expect(approved?.executionStatus).toBe('succeeded')
    expect(listMemoryItems().filter((i) => i.title === '偏好中文回复')).toHaveLength(1)

    const again = await approveApproval(approval.id)
    expect(again?.status).toBe('approved')
    expect(listMemoryItems().filter((i) => i.title === '偏好中文回复')).toHaveLength(1)
  })
  test('拒绝不写入；敏感候选在进入审批链前被拦截', async () => {
    const approval = createMemoryApproval('run-2', '应被拒绝的记忆', '不应写入')
    rejectApproval(approval.id)
    expect(listMemoryItems().filter((i) => i.title === '应被拒绝的记忆')).toHaveLength(0)

    expect(containsSensitiveContent('api_key = sk-ABCDEFGHIJKLMNOP1234')).toBe(true)
    expect(containsSensitiveContent('普通的用户偏好')).toBe(false)
    const mixed = extractMemoryCandidatesFromOutput(memoryBlock([
      { title: '正常事实', content: '项目使用 Bun', kind: 'fact' },
      { title: '泄漏', content: 'api_key = sk-ABCDEFGHIJKLMNOP1234', kind: 'fact' },
      { title: '私钥', content: '-----BEGIN PRIVATE KEY-----', kind: 'fact' },
    ]))
    expect(mixed.map((c) => c.title)).toEqual(['正常事实'])
    // 敏感候选不进入待审批列表
    expect(getPendingApprovals().filter((a) => a.title.includes('泄漏'))).toHaveLength(0)
  })
})
