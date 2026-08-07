/** Computer Use 本地 JSONL 审计，不持久化截图或敏感输入原文。 */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'

export async function appendComputerUseAudit(sessionId: string, action: string, detail: Record<string, unknown>): Promise<void> {
  const memberId = resolveMemberForSessionSafe(sessionId)
  const directory = join(getConfigDir(), 'computer-use-audit')
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
