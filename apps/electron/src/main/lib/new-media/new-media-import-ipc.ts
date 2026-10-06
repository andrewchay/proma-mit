/**
 * 报表导入的 IPC 层。
 *
 * 文件由主进程通过系统文件选择器读取，渲染进程只拿到预览结果与短期凭据：
 * - 绝对路径不进入渲染进程，也不进入日志。
 * - 凭据只指向内存中已解析的文件，单次提交后立即失效。
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { type BrowserWindow, dialog } from 'electron'
import type { NewMediaImportPreview, NewMediaImportSourceKind } from '@gravitas/shared'
import { parseImportFile, previewNewMediaImport, type ParsedImportFile } from './new-media-report-import'

interface PendingImport {
  parsed: ParsedImportFile
  sourceKind: NewMediaImportSourceKind
  accountId: string
  createdAt: number
}

const PENDING_TTL_MS = 10 * 60 * 1000
const MAX_PENDING = 5
const pending = new Map<string, PendingImport>()

function prunePending(): void {
  const now = Date.now()
  for (const [token, entry] of pending) {
    if (now - entry.createdAt > PENDING_TTL_MS) pending.delete(token)
  }
  // 只保留最近的若干条，避免长期驻留文件内容。
  while (pending.size > MAX_PENDING) {
    const oldest = [...pending.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt)[0]
    if (!oldest) break
    pending.delete(oldest[0])
  }
}

export function takePendingImport(token: string): PendingImport | undefined {
  prunePending()
  return pending.get(token)
}

export function clearPendingImport(token: string): void {
  pending.delete(token)
}

export async function pickAndPreviewReportFile(input: {
  sourceKind: NewMediaImportSourceKind
  accountId: string
  owner: BrowserWindow | null
}): Promise<{ canceled: true } | { canceled: false; preview: NewMediaImportPreview }> {
  const options = {
    title: '选择小红书报表文件',
    properties: ['openFile' as const],
    filters: [{ name: '报表文件', extensions: ['csv', 'xlsx', 'xlsm'] }],
  }
  const result = input.owner ? await dialog.showOpenDialog(input.owner, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return { canceled: true }
  const filePath = result.filePaths[0]
  if (!filePath) return { canceled: true }

  const parsed = await parseImportFile({ fileName: basename(filePath), bytes: new Uint8Array(readFileSync(filePath)) })
  prunePending()
  const token = randomUUID()
  pending.set(token, { parsed, sourceKind: input.sourceKind, accountId: input.accountId, createdAt: Date.now() })
  const preview = await previewNewMediaImport({ sourceKind: input.sourceKind, accountId: input.accountId, parsed, pendingToken: token })
  return { canceled: false, preview }
}
