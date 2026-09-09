import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ExitPlanDocument } from '@gravitas/shared'

const MAX_PLAN_DOCUMENT_BYTES = 1024 * 1024

/** 解析供审批预览的计划文件；真实路径必须位于会话 plan 目录内且不能经过符号链接。 */
export function resolvePlanDocument(value: unknown, planDirectory: string | undefined): ExitPlanDocument | undefined {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value.trim()) || !planDirectory) return undefined
  try {
    const directoryStat = lstatSync(planDirectory)
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return undefined
    const resolvedDirectory = realpathSync(planDirectory)
    const candidatePath = resolve(value.trim())
    const candidateStat = lstatSync(candidatePath)
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) return undefined
    const resolvedFilePath = realpathSync(candidatePath)
    const relativePath = relative(resolvedDirectory, resolvedFilePath)
    const insideDirectory = relativePath.length > 0
      && relativePath !== '..'
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath)
    if (!insideDirectory || extname(resolvedFilePath).toLowerCase() !== '.md') return undefined
    if (statSync(resolvedFilePath).size > MAX_PLAN_DOCUMENT_BYTES) return undefined
    return {
      filePath: resolvedFilePath,
      displayName: basename(resolvedFilePath),
      contentHash: createHash('sha256').update(readFileSync(resolvedFilePath)).digest('hex'),
    }
  } catch {
    return undefined
  }
}

/** 批准前确认用户看到的仍是同一份计划。 */
export function isPlanDocumentCurrent(document: ExitPlanDocument, planDirectory: string | undefined): boolean {
  const current = resolvePlanDocument(document.filePath, planDirectory)
  return current?.filePath === document.filePath && current.contentHash === document.contentHash
}
