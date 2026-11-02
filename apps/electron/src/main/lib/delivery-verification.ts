/**
 * 交付核实（借鉴卡兹克 CI 五步的第五步「核实」）
 *
 * Agent 声称完成 ≠ 真的完成：结算前由独立探针验证 summary 声明的可信度，
 * 结论并入验收备注（completionNotes 前缀），Pilot 执行追加写不可变回执。
 *
 * 原则：只核实与升级信息，不做自动回滚；核实失败不改变 paused 待人工确认的闸门，
 * 只是把「交付待确认」升级为「核实未通过」让人优先处理。
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { getProjectDb } from './project-sqlite-store'
import type { AgentExecution } from './project-types'

export interface DeliveryVerificationCheck {
  id: string
  kind: 'summary' | 'artifacts'
  passed: boolean
  detail: string
}

export interface DeliveryVerificationReport {
  executionId: string
  checkedAt: number
  passed: boolean
  passedCount: number
  totalCount: number
  checks: DeliveryVerificationCheck[]
}

export interface VerifyDeliveryInput {
  executionId: string
  /** Agent 的交付摘要（resultSummary / completionNotes） */
  summary: string
  /** 路径存在性检查（缺省 fs.existsSync；测试注入假实现） */
  pathExists?: (path: string) => boolean
}

/** 摘要少于该长度视为「没有可核实的交付说明」 */
const SUMMARY_MIN_LENGTH = 10
/** 最多核实的路径数量，防止超长摘要拖慢结算 */
const MAX_PATH_CHECKS = 8
/** 摘要中的绝对路径（工作区产物通常以 / 开头） */
const PATH_PATTERN = /(?:^|[\s（(【"'])(\/[\w.@+\-/]{3,})(?=[\s）)】"'，,。;；]|$)/g

/** 交付核实探针：摘要非空 + 摘要中声明的产物路径真实存在 */
export function verifyDelivery(input: VerifyDeliveryInput): DeliveryVerificationReport {
  const checks: DeliveryVerificationCheck[] = []
  const pathExists = input.pathExists ?? ((path: string) => existsSync(path))

  // 1. 摘要存在性：没有说明就无法核实
  const trimmed = input.summary.trim()
  const summaryOk = trimmed.length >= SUMMARY_MIN_LENGTH
  checks.push({
    id: 'summary_present',
    kind: 'summary',
    passed: summaryOk,
    detail: summaryOk ? `摘要 ${trimmed.length} 字` : '摘要缺失或过短（不足 10 字），无法核实交付内容',
  })

  // 2. 产物路径存在性：摘要声明的路径必须真实存在
  const declared = [...new Set([...trimmed.matchAll(PATH_PATTERN)].map((m) => m[1]!))].slice(0, MAX_PATH_CHECKS)
  if (declared.length === 0) {
    checks.push({
      id: 'artifact_paths_exist',
      kind: 'artifacts',
      passed: true,
      detail: '摘要未声明文件路径，跳过产物存在性检查',
    })
  } else {
    const missing = declared.filter((path) => !pathExists(path))
    checks.push({
      id: 'artifact_paths_exist',
      kind: 'artifacts',
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? `声明的 ${declared.length} 个路径均存在`
          : `声明 ${declared.length} 个路径中 ${missing.length} 个不存在：${missing.join('、')}`,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  return {
    executionId: input.executionId,
    checkedAt: Date.now(),
    passed: passedCount === checks.length,
    passedCount,
    totalCount: checks.length,
    checks,
  }
}

/** 核实结论 → completionNotes 前缀 */
export function formatVerificationPrefix(report: DeliveryVerificationReport): string {
  return report.passed
    ? `【交付核实 ${report.passedCount}/${report.totalCount} 通过】`
    : `【核实未通过 ${report.totalCount - report.passedCount}/${report.totalCount} 项】`
}

/**
 * Pilot 执行的核实回执（不可变表；INSERT-only，immutable trigger 拒绝 UPDATE）。
 * 非 Pilot 执行（无 pilotCommandId）不写回执，只影响 completionNotes。
 */
export function recordDeliveryVerificationReceipt(execution: AgentExecution, report: DeliveryVerificationReport): void {
  if (!execution.pilotCommandId) return
  const db = getProjectDb()
  const serialized = JSON.stringify(report)
  const payloadHash = createHash('sha256').update(`${execution.id}|${report.checkedAt}|${serialized}`).digest('hex')
  db.prepare(
    `INSERT OR IGNORE INTO pilot_delivery_verification_receipts
      (id, execution_id, project_id, session_id, passed, passed_count, total_count, report, payload_hash, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    execution.id,
    execution.projectId,
    execution.sessionId ?? null,
    report.passed ? 1 : 0,
    report.passedCount,
    report.totalCount,
    serialized,
    payloadHash,
    report.checkedAt,
  )
}

/** 读取执行最近的核实回执（无则 null） */
export function readDeliveryVerificationReceipt(executionId: string): DeliveryVerificationReport | null {
  const row = getProjectDb().prepare('SELECT report FROM pilot_delivery_verification_receipts WHERE execution_id = ?').get(executionId) as
    | { report: string }
    | undefined
  if (!row) return null
  try {
    return JSON.parse(row.report) as DeliveryVerificationReport
  } catch {
    return null
  }
}
