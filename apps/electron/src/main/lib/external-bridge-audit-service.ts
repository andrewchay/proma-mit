/** 外部 IM 入口审计：只保存关联标识和权限决策，不保存消息正文、附件内容或原始用户 ID。 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'

export interface ExternalBridgeAuditInput {
  sessionId: string
  /** 外部消息一次 Agent 执行的可关联任务 ID。 */
  requestId: string
  platform: string
  senderId?: string
  chatId: string
  permissionMode: 'safe' | 'bypassPermissions'
  outcome: 'received' | 'completed' | 'failed'
  /**
   * 仅用于推导错误分类，绝不写入审计文件。
   * Provider 或工具错误可能回显外部消息、路径或凭证片段。
   */
  error?: string
}

export async function appendExternalBridgeAudit(input: ExternalBridgeAuditInput): Promise<void> {
  const directory = join(getConfigDir(), 'external-bridge-audit')
  const detail = {
    platform: input.platform,
    taskId: input.requestId,
    senderHash: hashIdentifier(input.senderId),
    chatHash: hashIdentifier(input.chatId),
    permissionMode: input.permissionMode,
    outcome: input.outcome,
    ...(input.error ? { errorCode: classifyError(input.error) } : {}),
  }
  await mkdir(directory, { recursive: true })
  await appendFile(join(directory, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), sessionId: input.sessionId, action: 'external_message', detail })}\n`, 'utf8')
}

function classifyError(error: string): string {
  const normalized = error.toLowerCase()
  if (normalized.includes('cancel')) return 'cancelled'
  if (normalized.includes('timeout') || normalized.includes('超时')) return 'timeout'
  if (normalized.includes('permission') || normalized.includes('权限')) return 'permission_denied'
  if (normalized.includes('401') || normalized.includes('unauthorized') || normalized.includes('认证')) return 'authentication_failed'
  if (normalized.includes('429') || normalized.includes('rate limit') || normalized.includes('限流')) return 'rate_limited'
  return 'runtime_error'
}

function hashIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}
