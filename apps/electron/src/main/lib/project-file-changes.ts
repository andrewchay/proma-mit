/** 本地项目文件快照；有限读取文本计算摘要，不保存正文。 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { constants } from 'node:fs'
import { getProjectsDir } from './config-paths'
import type { ProjectWorkspaceFileChangesView } from '@gravitas/shared'
type ProjectFileScanView = Omit<ProjectWorkspaceFileChangesView, 'watching'>

const ignored = new Set(['.git', 'node_modules', '.next', '.nuxt', 'dist', 'build', '.cache', '__pycache__', '.turbo', '.parcel-cache', '.svelte-kit'])
const MAX_FILES = 20000
const MAX_EVENTS = 1000
const MAX_HASH_FILE_BYTES = 1024 * 1024
const MAX_HASH_TOTAL_BYTES = 64 * 1024 * 1024

interface FileMetadata { size: number; modified: number; changed?: number; sha256?: string }
export interface ProjectFileChange { path: string; kind: 'added' | 'modified' | 'deleted' | 'renamed'; observedAt: number; previousPath?: string; evidence?: 'content' | 'metadata' | 'matching_digest' }
interface Snapshot { version: 1; root: string; files: Record<string, FileMetadata>; events: ProjectFileChange[]; scannedAt?: number; ignorePrefixes?: string[] }
const scanErrors = new Map<string, { root: string; message: string }>()

function snapshotPath(workspaceId: string): string {
  const key = createHash('sha256').update(workspaceId).digest('hex')
  return join(getProjectsDir(), 'file-changes', `${key}.json`)
}

/** .gravitasignore 每行一个根目录相对路径；不支持通配符，避免与 Git 规则混淆。 */
async function readIgnorePrefixes(root: string): Promise<string[]> {
  const path = join(root, '.gravitasignore')
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > 65536) throw new Error('.gravitasignore 必须是小于 64KB 的普通文件')
    const content = await readFile(path, 'utf8')
    const prefixes = content.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => line.replace(/\/$/, ''))
    if (prefixes.length > 256) throw new Error('.gravitasignore 最多支持 256 条路径')
    if (prefixes.some(line => !line || line.startsWith('/') || line.includes('\\') || /[*?\[\]]/.test(line) || line.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('.gravitasignore 只能包含项目内的相对路径，不支持通配符')
    return [...new Set(prefixes)].sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function collect(root: string, ignorePrefixes: string[]): Promise<Record<string, FileMetadata>> {
  const files: Record<string, FileMetadata> = Object.create(null)
  let count = 0
  let bytesHashed = 0
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      const name = relative(root, path).replace(/\\/g, '/')
      if (ignorePrefixes.some(prefix => name === prefix || name.startsWith(`${prefix}/`))) continue
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        if (++count > MAX_FILES) throw new Error('文件数量超过项目变化扫描上限')
        const info = await stat(path)
        const metadata: FileMetadata = { size: info.size, modified: info.mtimeMs, changed: info.ctimeMs }
        if (info.size <= MAX_HASH_FILE_BYTES && bytesHashed + info.size <= MAX_HASH_TOTAL_BYTES) {
          const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
          try {
            const before = await handle.stat()
            if (!before.isFile() || before.size !== info.size || before.ino !== info.ino || before.dev !== info.dev) throw new Error('文件在扫描期间发生变化')
            const buffer = Buffer.alloc(before.size + 1)
            let length = 0
            while (length < buffer.length) {
              const result = await handle.read(buffer, length, buffer.length - length, length)
              if (!result.bytesRead) break
              length += result.bytesRead
            }
            if (length !== before.size) throw new Error('文件在扫描期间发生变化')
            const bytes = buffer.subarray(0, length)
            const after = await handle.stat()
            if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('文件在扫描期间发生变化')
            bytesHashed += bytes.length
            try {
              new TextDecoder('utf-8', { fatal: true }).decode(bytes)
              if (!bytes.includes(0)) metadata.sha256 = createHash('sha256').update(bytes).digest('hex')
            } catch { /* 非 UTF-8 或二进制文件只使用元数据。 */ }
          } finally { await handle.close() }
        }
        files[name] = metadata
      }
    }
  }
  await visit(root)
  return files
}

/** 扫描失败时不写入快照，避免把不可读目录误判为文件删除。首次扫描仅建立基线。 */
export async function scanProjectFileChanges(workspaceId: string, root: string): Promise<ProjectFileChange[]> {
  try {
    const result = await scanProjectFileChangesInternal(workspaceId, root)
    scanErrors.delete(workspaceId)
    return result
  } catch (error) {
    scanErrors.set(workspaceId, { root, message: error instanceof Error ? error.message : '扫描失败' })
    throw error
  }
}

async function scanProjectFileChangesInternal(workspaceId: string, root: string): Promise<ProjectFileChange[]> {
  const path = snapshotPath(workspaceId)
  let previous: Snapshot | undefined
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1 || !('root' in value) || value.root !== root || !('files' in value) || typeof value.files !== 'object' || value.files === null || !('events' in value) || !Array.isArray(value.events)) throw new Error('项目文件快照无效')
    previous = value as Snapshot
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const ignorePrefixes = await readIgnorePrefixes(root)
  const files = await collect(root, ignorePrefixes)
  const now = Date.now()
  const changes: ProjectFileChange[] = []
  if (previous && JSON.stringify(previous.ignorePrefixes ?? []) === JSON.stringify(ignorePrefixes)) {
    const added = Object.keys(files).filter(name => !Object.hasOwn(previous.files, name))
    const deleted = Object.keys(previous.files).filter(name => !Object.hasOwn(files, name))
    const matchedAdded = new Set<string>()
    const matchedDeleted = new Set<string>()
    const groupByHash = (names: string[], source: Record<string, FileMetadata>): Map<string, string[]> => {
      const groups = new Map<string, string[]>()
      for (const name of names) {
        const hash = source[name]?.sha256
        if (hash) { const group = groups.get(hash) ?? []; group.push(name); groups.set(hash, group) }
      }
      return groups
    }
    const oldGroups = groupByHash(deleted, previous.files)
    const newGroups = groupByHash(added, files)
    for (const [hash, names] of newGroups) {
      const oldNames = oldGroups.get(hash)
      if (names.length === 1 && oldNames?.length === 1) {
        const name = names[0]!, old = oldNames[0]!
        matchedAdded.add(name); matchedDeleted.add(old)
        changes.push({ path: name, previousPath: old, kind: 'renamed', observedAt: now, evidence: 'matching_digest' })
      }
    }
    for (const name of added) if (!matchedAdded.has(name)) changes.push({ path: name, kind: 'added', observedAt: now, evidence: files[name]?.sha256 ? 'content' : 'metadata' })
    for (const name of deleted) if (!matchedDeleted.has(name)) changes.push({ path: name, kind: 'deleted', observedAt: now, evidence: previous.files[name]?.sha256 ? 'content' : 'metadata' })
    for (const [name, info] of Object.entries(files)) {
      const old = Object.hasOwn(previous.files, name) ? previous.files[name] : undefined
      if (!old) continue
      const contentComparable = Boolean(old.sha256 && info.sha256)
      const changed = contentComparable ? old.sha256 !== info.sha256 : old.size !== info.size || old.modified !== info.modified || (old.changed !== undefined && old.changed !== info.changed)
      if (changed) changes.push({ path: name, kind: 'modified', observedAt: now, evidence: contentComparable ? 'content' : 'metadata' })
    }
  }
  const next: Snapshot = { version: 1, root, files, events: [...(previous?.events ?? []), ...changes].slice(-MAX_EVENTS), scannedAt: now, ignorePrefixes }
  await mkdir(join(getProjectsDir(), 'file-changes'), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(next), { flag: 'wx' })
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(() => {})
  }
  return changes
}

/** 用户主动查看工作区记录；不读取文件正文。 */
export async function readProjectFileChanges(workspaceId: string, root: string, limit = 100): Promise<ProjectFileScanView> {
  try {
    const snapshot: Snapshot = JSON.parse(await readFile(snapshotPath(workspaceId), 'utf8'))
    if (snapshot.version !== 1 || snapshot.root !== root || !Array.isArray(snapshot.events) || snapshot.events.some(event => !event || typeof event.path !== 'string' || !['added', 'modified', 'deleted', 'renamed'].includes(event.kind) || !Number.isFinite(event.observedAt))) throw new Error('项目文件快照无效')
    return { changes: snapshot.events.slice(-Math.min(MAX_EVENTS, Math.max(1, limit))).reverse(), lastScannedAt: typeof snapshot.scannedAt === 'number' ? snapshot.scannedAt : null, scanError: scanErrors.get(workspaceId)?.root === root ? scanErrors.get(workspaceId)!.message : null }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { changes: [], lastScannedAt: null, scanError: scanErrors.get(workspaceId)?.root === root ? scanErrors.get(workspaceId)!.message : null }
    throw error
  }
}
