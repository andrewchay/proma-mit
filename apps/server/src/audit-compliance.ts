/**
 * 企业版审计合规服务
 *
 * 为服务端提供审计合规功能：
 * - 审计日志 hash 链验证
 * - 法律保全（AuditLegalHold）
 * - 按租户导出审计日志
 */

import type { AgentRuntimeScope } from '@gravitas/shared'
import type { PostgresAuditLog, AuditChainVerification, AuditLegalHold } from './audit.ts'

export interface AuditComplianceService {
  /** 验证审计 hash 链完整性 */
  verifyChain(scope: AgentRuntimeScope): Promise<AuditChainVerification>

  /** 创建法律保全 */
  createLegalHold(scope: AgentRuntimeScope, holdId: string, reason: string): Promise<void>

  /** 释放法律保全 */
  releaseLegalHold(scope: AgentRuntimeScope, holdId: string): Promise<boolean>

  /** 检查是否存在有效法律保全 */
  hasActiveLegalHold(scope: AgentRuntimeScope): Promise<boolean>

  /** 按租户导出审计日志 */
  exportAuditLog(scope: AgentRuntimeScope, options: { from?: number; to?: number; format?: 'json' | 'csv' }): Promise<string>

  /** 清理过期审计记录（需先确认无法律保全） */
  purgeAuditLog(scope: AgentRuntimeScope, beforeTimestamp: number): Promise<void>
}

export function createAuditComplianceService(auditLog: PostgresAuditLog): AuditComplianceService {
  return {
    async verifyChain(scope: AgentRuntimeScope): Promise<AuditChainVerification> {
      return auditLog.verifyChain(scope)
    },

    async createLegalHold(scope: AgentRuntimeScope, holdId: string, reason: string): Promise<void> {
      const hold: AuditLegalHold = {
        ...scope,
        holdId,
        reason,
        createdAt: Date.now(),
      }
      await auditLog.createLegalHold(hold)
    },

    async releaseLegalHold(scope: AgentRuntimeScope, holdId: string): Promise<boolean> {
      return auditLog.releaseLegalHold(scope, holdId)
    },

    async hasActiveLegalHold(scope: AgentRuntimeScope): Promise<boolean> {
      return auditLog.hasActiveLegalHold(scope)
    },

    async exportAuditLog(
      scope: AgentRuntimeScope,
      options: { from?: number; to?: number; format?: 'json' | 'csv' } = {},
    ): Promise<string> {
      const records: import('./audit.ts').AuditRecord[] = await auditLog.list({
        ...scope,
        from: options.from,
        to: options.to,
        limit: 1000,
      })

      if (options.format === 'csv') {
        // CSV 格式导出
        const headers = ['tenantId', 'userId', 'action', 'resource', 'result', 'createdAt', 'requestId', 'traceId', 'taskId']
        const rows = records.map((r) => [
          r.tenantId,
          r.userId,
          r.action,
          r.resource,
          r.result,
          r.createdAt ?? '',
          r.requestId ?? '',
          r.traceId ?? '',
          r.taskId ?? '',
        ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
        return [headers.join(','), ...rows].join('\n')
      }

      // 默认 JSON 格式
      return JSON.stringify(records, null, 2)
    },

    async purgeAuditLog(scope: AgentRuntimeScope, beforeTimestamp: number): Promise<void> {
      if (await auditLog.hasActiveLegalHold(scope)) {
        throw new Error('当前租户存在有效法律保全，禁止清理审计记录')
      }
      await auditLog.purgeBefore(scope, beforeTimestamp)
    },
  }
}
