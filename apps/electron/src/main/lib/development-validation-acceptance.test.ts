import { describe, expect, test } from 'bun:test'
import type { DevelopmentValidationEvidence } from '@gravitas/shared'
import { DEVELOPMENT_VALIDATION_CLOCK_SKEW_MS, DEVELOPMENT_VALIDATION_EVIDENCE_VALIDITY_MS, evaluateDevelopmentValidationEvidence, isOwnerValidationEvidenceExpired } from './development-validation-acceptance'

const HASH = 'a'.repeat(64)

function evidence(overrides: Partial<DevelopmentValidationEvidence['result']> = {}, freshness: DevelopmentValidationEvidence['freshness'] = 'fresh'): DevelopmentValidationEvidence {
  return {
    freshness,
    result: {
      id: 'validation-1',
      taskId: 'task-1',
      executionId: 'exec-1',
      command: 'browser:html.loads+dom.board',
      startedAt: 1000,
      finishedAt: 2000,
      exitCode: 0,
      timedOut: false,
      status: 'passed',
      snapshotContentHash: HASH,
      outputTail: '',
      outputTruncated: false,
      method: 'browser_assertions',
      checks: [
        { id: 'html.loads', title: '页面可加载', status: 'passed', detail: '无脚本错误' },
        { id: 'dom.board', title: '棋盘 16 格', status: 'passed', detail: '16' },
      ],
      ...overrides,
    },
  }
}

const options = { expectedSnapshotHash: HASH, now: 2000 + 60_000 }

describe('运行验证证据采信规则', () => {
  test('Given 新鲜成功的浏览器断言 When 成果哈希一致且未超期 Then 采信', () => {
    expect(evaluateDevelopmentValidationEvidence(evidence(), options).accepted).toBe(true)
  })

  test('Given 没有证据 When 判定 Then 拒绝并说明缺少证据', () => {
    expect(evaluateDevelopmentValidationEvidence(undefined, options)).toEqual({ accepted: false, reason: '缺少运行验证证据' })
  })

  test('Given 证据为 stale When 判定 Then 拒绝且带上游原因', () => {
    const verdict = evaluateDevelopmentValidationEvidence(evidence({}, 'stale'), options)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reason).toContain('stale')
  })

  test('Given 进程超时未确认退出 When 判定 Then 拒绝', () => {
    expect(evaluateDevelopmentValidationEvidence(evidence({ exitCode: null, timedOut: true }), options).reason).toBe('进程未确认退出，不能计为成功')
  })

  test('Given 输出被截断 When 判定 Then 拒绝', () => {
    expect(evaluateDevelopmentValidationEvidence(evidence({ outputTruncated: true }), options).reason).toBe('输出被截断，不能作为成功依据')
  })

  test('Given 成果在验证后被修改 When 判定 Then 拒绝并要求重新验证', () => {
    const verdict = evaluateDevelopmentValidationEvidence(evidence(), { expectedSnapshotHash: 'b'.repeat(64), now: 2000 })
    expect(verdict.reason).toBe('证据绑定的成果已变更，须重新验证')
  })

  test('Given 证据超过 30 分钟 When 判定 Then 过期拒绝', () => {
    const expired = { expectedSnapshotHash: HASH, now: 2000 + DEVELOPMENT_VALIDATION_EVIDENCE_VALIDITY_MS + 1 }
    expect(evaluateDevelopmentValidationEvidence(evidence(), expired).reason).toBe('证据已过期（有效期 30 分钟）')
  })

  test('Given 浏览器断言缺少逐项结果 When 判定 Then 拒绝只凭退出码', () => {
    expect(evaluateDevelopmentValidationEvidence(evidence({ checks: [] }), options).reason).toBe('浏览器断言缺少逐项结果，不能只凭退出码采信')
  })

  test('Given 断言全为 skipped When 判定 Then 拒绝（不适用不等于通过）', () => {
    const allSkipped = evidence({ checks: [{ id: 'behavior.merge', title: '合并计分', status: 'skipped', detail: '未找到键盘处理器' }] })
    expect(evaluateDevelopmentValidationEvidence(allSkipped, options).reason).toBe('没有任何通过的断言项')
  })

  test('Given 存在失败断言 When 判定 Then 拒绝', () => {
    const withFailure = evidence({ checks: [{ id: 'html.loads', title: '页面可加载', status: 'passed', detail: 'ok' }, { id: 'dom.board', title: '棋盘 16 格', status: 'failed', detail: '只有 0 格' }] })
    expect(evaluateDevelopmentValidationEvidence(withFailure, options).reason).toBe('存在失败的断言项')
  })

  test('Given command 方式退出码非 0 When 判定 Then 按状态拒绝', () => {
    const failed = evidence({ method: 'command', checks: undefined, status: 'failed', exitCode: 1 })
    expect(evaluateDevelopmentValidationEvidence(failed, options).reason).toBe('验证状态为 failed，不是成功')
  })

  test('Given 历史记录缺省 method When 判定 Then 按 command 语义采信成功记录', () => {
    const legacy = evidence({ method: undefined, checks: undefined, status: 'passed', exitCode: 0 })
    expect(evaluateDevelopmentValidationEvidence(legacy, options).accepted).toBe(true)
  })
})

test('Given 断言全过但整体状态失败或退出码非0 When 判定 Then 拒绝（不能只信 checks）', () => {
  const inconsistent = evidence({ status: 'failed', exitCode: 1 })
  expect(evaluateDevelopmentValidationEvidence(inconsistent, options).accepted).toBe(false)
  expect(evaluateDevelopmentValidationEvidence(inconsistent, options).reason).toContain('不是成功')
})

describe('交接后按门禁时刻重算有效期', () => {
  test('Given 交接时未过期但已超期 When 验收时判定 Then 视为过期', () => {
    const finishedAt = 1_000
    const later = finishedAt + DEVELOPMENT_VALIDATION_EVIDENCE_VALIDITY_MS + 1
    // 交接时写下的 expired=false 不能代表之后的判定。
    expect(isOwnerValidationEvidenceExpired({ finishedAt, expired: false }, finishedAt + 1_000)).toBe(false)
    expect(isOwnerValidationEvidenceExpired({ finishedAt, expired: false }, later)).toBe(true)
  })

  test('Given 交接时已标记过期 When 即便时间未到 Then 仍视为过期', () => {
    expect(isOwnerValidationEvidenceExpired({ finishedAt: 1_000, expired: true }, 2_000)).toBe(true)
  })

  test('Given 缺少完成时间 When 判定 Then 不凭空判过期（由其他字段负责拒绝）', () => {
    expect(isOwnerValidationEvidenceExpired({}, Date.now())).toBe(false)
  })
})

describe('时间戳作弊', () => {
  test('Given 完成时间在未来 When 采信判定 Then 拒绝而不是永久有效', () => {
    const future = evidence({ finishedAt: options.now + DEVELOPMENT_VALIDATION_CLOCK_SKEW_MS + 60_000 })
    expect(evaluateDevelopmentValidationEvidence(future, options)).toEqual({ accepted: false, reason: '证据完成时间在未来，不能采信' })
  })

  test('Given 完成时间在未来 When 门禁判定过期 Then 视为不可采信', () => {
    const now = 10_000
    expect(isOwnerValidationEvidenceExpired({ finishedAt: now + DEVELOPMENT_VALIDATION_CLOCK_SKEW_MS + 1 }, now)).toBe(true)
  })
})
