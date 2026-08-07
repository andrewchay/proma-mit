/** Web Bridge 本地 JSONL 审计；只保存操作摘要，不保存页面正文、截图或上传文件内容。 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'

export async function appendWebBridgeAudit(sessionId: string, action: string, detail: Record<string, unknown>): Promise<void> {
  const memberId = resolveMemberForSessionSafe(sessionId)
  const directory = join(getConfigDir(), 'web-bridge-audit')
  await mkdir(directory, { recursive: true })
  await appendFile(join(directory, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), sessionId, action, detail, ...(memberId ? { memberId } : {}) })}\n`, 'utf8')
}

function resolveMemberForSessionSafe(sessionId: string): string | undefined {
  try {
    const { resolveMemberForSession } = require('./app-event-bus')
    return resolveMemberForSession(sessionId)
  } catch {
    return undefined
  }
}
