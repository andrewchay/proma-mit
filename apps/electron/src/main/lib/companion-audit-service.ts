/**
 * Companion 操作审计
 *
 * 追加式本地 JSONL（~/.gravitas/companion-audit/events.jsonl）。
 * 只记操作摘要（action / sessionId / requestId 类短标识），不记消息正文、
 * 工具输入、token 或配对码 —— 与 Web Bridge 审计边界保持一致。
 * 写失败静默：审计不可用不能阻塞远程操作主流程。
 */

import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'

export interface CompanionAuditInput {
  /** 操作类型：pair / pair_failed / send_message / stop / permission_allow / permission_deny / ask_user_respond */
  action: string
  sessionId?: string
  /** 仅限 requestId 类短标识，禁止传入消息正文或工具输入 */
  detail?: string
}

export async function appendCompanionAudit(input: CompanionAuditInput): Promise<void> {
  try {
    const directory = join(getConfigDir(), 'companion-audit')
    await mkdir(directory, { recursive: true })
    const line = JSON.stringify({
      at: new Date().toISOString(),
      action: input.action,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
    })
    await appendFile(join(directory, 'events.jsonl'), `${line}\n`, 'utf8')
  } catch (error) {
    console.error('[CompanionAudit] 写入失败:', error)
  }
}
