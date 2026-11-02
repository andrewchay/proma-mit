/**
 * 交付核实测试：探针 checks / 前缀格式 / 不可变回执
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatVerificationPrefix,
  readDeliveryVerificationReceipt,
  recordDeliveryVerificationReceipt,
  verifyDelivery,
} from './delivery-verification'
import { closeProjectDb, getProjectDb, initProjectDb } from './project-sqlite-store'
import type { AgentExecution } from './project-types'

describe('交付核实探针', () => {
  test('摘要充分且声明的路径全部存在 → 通过', () => {
    const report = verifyDelivery({
      executionId: 'exec-1',
      summary: '已完成重构，产物见 /tmp/build/main.js 与 /tmp/build/index.css',
      pathExists: (p) => p.startsWith('/tmp/build/'),
    })
    expect(report.passed).toBe(true)
    expect(report.totalCount).toBe(2)
    expect(report.checks.every((c) => c.passed)).toBe(true)
  })

  test('声明路径不存在 → 不通过并列出缺失路径', () => {
    const report = verifyDelivery({
      executionId: 'exec-2',
      summary: '完成交付：/tmp/exists/a.txt 与 /tmp/missing/b.txt 已生成',
      pathExists: (p) => !p.includes('missing'),
    })
    expect(report.passed).toBe(false)
    const artifactCheck = report.checks.find((c) => c.id === 'artifact_paths_exist')!
    expect(artifactCheck.passed).toBe(false)
    expect(artifactCheck.detail).toContain('/tmp/missing/b.txt')
    expect(artifactCheck.detail).not.toContain('/tmp/exists/a.txt')
  })

  test('摘要过短 → summary_present 不通过', () => {
    const report = verifyDelivery({ executionId: 'exec-3', summary: '好了', pathExists: () => true })
    expect(report.passed).toBe(false)
    expect(report.checks.find((c) => c.id === 'summary_present')!.passed).toBe(false)
  })

  test('摘要无可识别路径 → 产物未检查，不声称通过', () => {
    const report = verifyDelivery({
      executionId: 'exec-4',
      summary: '已完成全部配置修改并通过类型检查，等待人工验收。',
      pathExists: () => false,
    })
    expect(report.passed).toBe(false)
    expect(report.outcome).toBe('incomplete')
    expect(report.checks.find((c) => c.id === 'artifact_paths_exist')!.status).toBe('not_checked')
    expect(formatVerificationPrefix(report)).toContain('不完整')
  })

  test('路径数量截断到上限', () => {
    const many = Array.from({ length: 30 }, (_, i) => `/tmp/p-${i}`).join(' ')
    let checked = 0
    const report = verifyDelivery({ executionId: 'exec-5', summary: `完成 ${many}`, pathExists: () => { checked++; return true } })
    expect(checked).toBeLessThanOrEqual(8)
    expect(report.outcome).toBe('incomplete')
    expect(report.checks[1]?.detail).toContain('至少还有一个路径未检查')
  })

  test('识别部分绝对路径时明确其余格式未覆盖，不能称为交付验收', () => {
    const report = verifyDelivery({ executionId: 'exec-partial', summary: '产物在 /tmp/a.txt 和相对路径 dist/result.txt 中', pathExists: () => true })
    expect(report.checks[1]?.detail).toContain('其他格式的路径未覆盖')
    expect(formatVerificationPrefix(report)).toContain('已识别路径存在性')
    expect(formatVerificationPrefix(report)).toContain('待验收')
  })

  test('formatVerificationPrefix 两种结论', () => {
    const passed = verifyDelivery({ executionId: 'e1', summary: '全部完成，详见 /tmp/a.txt', pathExists: () => true })
    expect(formatVerificationPrefix(passed)).toBe('【摘要与已识别路径存在性检查通过，待验收】')
    const failed = verifyDelivery({ executionId: 'e2', summary: 'ok', pathExists: () => false })
    expect(formatVerificationPrefix(failed)).toBe('【摘要或路径检查未通过】')
  })
})

describe('交付核实回执（不可变表）', () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-verification-'))
  const previous = process.env.PROMA_TEST_CONFIG_DIR
  beforeAll(async () => {
    process.env.PROMA_TEST_CONFIG_DIR = root
    await initProjectDb()
  })
  afterAll(() => {
    closeProjectDb()
    if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
    else process.env.PROMA_TEST_CONFIG_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })

  function makeExecution(id: string, pilotCommandId?: string): AgentExecution {
    return {
      id,
      projectId: 'proj-1',
      entityType: 'task',
      entityId: 'task-1',
      agentId: 'agent-1',
      status: 'completed',
      createdAt: Date.now(),
      sessionId: 'session-test',
      prompt: '测试任务',
      startedAt: Date.now() - 1_000,
      ...(pilotCommandId ? { pilotCommandId } : {}),
    } as AgentExecution
  }

  test('Pilot 执行写回执并可读回；非 Pilot 执行不写', () => {
    const report = verifyDelivery({ executionId: 'exec-pilot', summary: '完成交付 /tmp/artifact.bin', pathExists: () => true })
    recordDeliveryVerificationReceipt(makeExecution('exec-pilot', 'command-1'), report)
    const loaded = readDeliveryVerificationReceipt('exec-pilot')
    expect(loaded?.passed).toBe(true)
    expect(loaded?.checks).toHaveLength(2)

    recordDeliveryVerificationReceipt(makeExecution('exec-plain'), report) // 无 pilotCommandId → 不写
    expect(readDeliveryVerificationReceipt('exec-plain')).toBeNull()
  })

  test('immutable trigger 拒绝 UPDATE（INSERT-only 账本）', () => {
    const report = verifyDelivery({ executionId: 'exec-immutable', summary: '完成全部工作并通过检查。', pathExists: () => true })
    recordDeliveryVerificationReceipt(makeExecution('exec-immutable', 'command-2'), report)
    let violated = false
    try {
      getProjectDb().prepare('UPDATE pilot_delivery_verification_receipts SET passed = 0 WHERE execution_id = ?').run('exec-immutable')
    } catch {
      violated = true
    }
    expect(violated).toBe(true)
    expect(readDeliveryVerificationReceipt('exec-immutable')?.outcome).toBe('incomplete')
  })

  test('旧回执缺少覆盖状态 → 读取时标记待核对且保留原始账本', () => {
    const legacy = { executionId: 'exec-legacy', checkedAt: 123, passed: true, passedCount: 2, totalCount: 2, checks: [] }
    getProjectDb().prepare('INSERT INTO pilot_delivery_verification_receipts (id, execution_id, project_id, session_id, passed, passed_count, total_count, report, payload_hash, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-receipt', 'exec-legacy', 'proj-1', null, 1, 2, 2, JSON.stringify(legacy), 'legacy-hash', 123)
    const result = readDeliveryVerificationReceipt('exec-legacy')
    expect(result?.outcome).toBe('legacy_unverified')
    expect(result?.passed).toBe(false)
    expect(formatVerificationPrefix(result!)).toContain('待核对')
    const row = getProjectDb().prepare('SELECT passed, report FROM pilot_delivery_verification_receipts WHERE execution_id = ?').get('exec-legacy') as { passed: number; report: string }
    expect(row.passed).toBe(1)
    expect(JSON.parse(row.report)).toEqual(legacy)
  })

  test('重复结算幂等：INSERT OR IGNORE 不抛错不重复', () => {
    const report = verifyDelivery({ executionId: 'exec-idem', summary: '完成迭代并自测通过。', pathExists: () => true })
    recordDeliveryVerificationReceipt(makeExecution('exec-idem', 'command-3'), report)
    recordDeliveryVerificationReceipt(makeExecution('exec-idem', 'command-3'), report)
    const count = getProjectDb().prepare('SELECT COUNT(*) AS n FROM pilot_delivery_verification_receipts WHERE execution_id = ?').get('exec-idem') as { n: number }
    expect(count.n).toBe(1)
  })
})
