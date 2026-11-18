import { createHash } from 'node:crypto'
import type { DevelopmentSnapshotFile } from '@gravitas/shared'

/** 文本按正文哈希，代码按冻结文件集合哈希；传输JSON不是源码版本的哈希域。 */
export function deliveryContentMatchesArtifact(content: string, artifactHash: string): boolean {
  const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
  if (sha(content) === artifactHash) return true
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  try {
    const value: unknown = JSON.parse(content)
    if (!record(value) || value.contentHash !== artifactHash || !Array.isArray(value.files) || !value.files.length
      || Object.keys(value).some(key => !['executionId', 'workspaceId', 'baseCommit', 'contentHash', 'files'].includes(key))
      || typeof value.executionId !== 'string' || !value.executionId || typeof value.workspaceId !== 'string' || !value.workspaceId
      || typeof value.baseCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseCommit)) return false
    const files: DevelopmentSnapshotFile[] = [], paths = new Set<string>()
    for (const entry of value.files as unknown[]) {
      if (!record(entry) || !record(entry.file)) return false
      const file = entry.file, before = entry.oldContent, after = entry.newContent
      if (typeof file.path !== 'string' || !file.path || file.path.includes('\0') || paths.has(file.path)
        || !['add', 'modify', 'delete'].includes(String(file.changeType))
        || !(before === null || typeof before === 'string') || !(after === null || typeof after === 'string')
        || (file.changeType === 'add' ? before !== null || after === null : file.changeType === 'delete' ? before === null || after !== null : before === null || after === null)
        || (before === null ? null : sha(before)) !== file.oldSha256 || (after === null ? null : sha(after)) !== file.newSha256
        || Buffer.byteLength(after ?? '', 'utf8') !== file.newBytes) return false
      paths.add(file.path)
      files.push({ path: file.path, changeType: file.changeType as DevelopmentSnapshotFile['changeType'], oldSha256: file.oldSha256 as string | null,
        newSha256: file.newSha256 as string | null, newBytes: Number(file.newBytes) })
    }
    const hash = createHash('sha256')
    for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) hash.update(`${file.path}\0${file.changeType}\0${file.oldSha256 ?? ''}\0${file.newSha256 ?? ''}\n`)
    return hash.digest('hex') === artifactHash
  } catch { return false }
}
