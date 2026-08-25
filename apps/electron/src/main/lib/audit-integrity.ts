/**
 * 开源版审计完整性校验
 *
 * 为 Electron 开源版提供轻量级的审计日志完整性校验。
 * 生成完整性报告，包含文件级哈希和条目统计。
 */

import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'

export interface AuditIntegrityReport {
  /** 审计日志文件路径 */
  filePath: string
  /** 文件级 SHA-256 哈希 */
  fileHash: string
  /** 审计条目数 */
  entryCount: number
  /** 最后一条记录的哈希 */
  lastEntryHash: string
  /** 校验时间戳 */
  verifiedAt: string
  /** 是否通过完整性检查 */
  valid: boolean
}

/**
 * 生成审计日志完整性报告
 *
 * 计算文件级哈希和条目统计，用于检测审计日志是否被篡改。
 */
export function generateAuditIntegrityReport(): AuditIntegrityReport {
  const filePath = join(getConfigDir(), 'config-audit', 'events.jsonl')

  if (!existsSync(filePath)) {
    return {
      filePath,
      fileHash: '',
      entryCount: 0,
      lastEntryHash: '',
      verifiedAt: new Date().toISOString(),
      valid: true, // 空文件视为有效
    }
  }

  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n').filter(Boolean)

  // 计算文件级哈希
  const fileHash = createHash('sha256').update(content).digest('hex')

  // 计算最后一条记录的哈希
  const lastEntry = lines[lines.length - 1]
  const lastEntryHash = lastEntry
    ? createHash('sha256').update(lastEntry).digest('hex')
    : ''

  return {
    filePath,
    fileHash,
    entryCount: lines.length,
    lastEntryHash,
    verifiedAt: new Date().toISOString(),
    valid: true,
  }
}

/**
 * 验证审计日志完整性
 *
 * 通过比对文件哈希和条目数，检测审计日志是否被篡改。
 */
export function verifyAuditIntegrity(expectedReport: AuditIntegrityReport): {
  valid: boolean
  mismatches: string[]
  current: AuditIntegrityReport
} {
  const current = generateAuditIntegrityReport()
  const mismatches: string[] = []

  if (current.fileHash !== expectedReport.fileHash) {
    mismatches.push('文件哈希不匹配：审计日志可能已被修改')
  }

  if (current.entryCount !== expectedReport.entryCount) {
    mismatches.push(`条目数不匹配：预期 ${expectedReport.entryCount}，实际 ${current.entryCount}`)
  }

  if (current.lastEntryHash !== expectedReport.lastEntryHash) {
    mismatches.push('最后条目哈希不匹配：审计日志尾部可能被修改')
  }

  return {
    valid: mismatches.length === 0,
    mismatches,
    current,
  }
}

/**
 * 导出审计完整性报告为 JSON
 */
export function exportAuditIntegrityReport(): string {
  const report = generateAuditIntegrityReport()
  return JSON.stringify(report, null, 2)
}
