/** 本地项目文件元数据快照；不读取或保存文件正文。 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { getProjectsDir } from './config-paths'
import type { ProjectWorkspaceFileChangesView } from '@gravitas/shared'

const ignored = new Set(['.git', 'node_modules', '.next', '.nuxt', 'dist', 'build', '.cache', '__pycache__', '.turbo', '.parcel-cache', '.svelte-kit'])
const MAX_FILES = 20000
const MAX_EVENTS = 1000

interface FileMetadata { size: number; modified: number; changed?: number }
export interface ProjectFileChange { path: string; kind: 'added' | 'modified' | 'deleted'; observedAt: number }
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
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      const name = relative(root, path).replace(/\\/g, '/')
      if (ignorePrefixes.some(prefix => name === prefix || name.startsWith(`${prefix}/`))) continue
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        if (++count > MAX_FILES) throw new Error('文件数量超过项目变化扫描上限')
        const info = await stat(path)
        files[name] = { size: info.size, modified: info.mtimeMs, changed: info.ctimeMs }
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
    for (const [name, info] of Object.entries(files)) {
      const old = Object.hasOwn(previous.files, name) ? previous.files[name] : undefined
      if (!old) changes.push({ path: name, kind: 'added', observedAt: now })
      else if (old.size !== info.size || old.modified !== info.modified || (old.changed !== undefined && old.changed !== info.changed)) changes.push({ path: name, kind: 'modified', observedAt: now })
    }
    for (const name of Object.keys(previous.files)) if (!files[name]) changes.push({ path: name, kind: 'deleted', observedAt: now })
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
export async function readProjectFileChanges(workspaceId: string, root: string): Promise<ProjectWorkspaceFileChangesView> {
  try {
    const snapshot: Snapshot = JSON.parse(await readFile(snapshotPath(workspaceId), 'utf8'))
    if (snapshot.version !== 1 || snapshot.root !== root || !Array.isArray(snapshot.events) || snapshot.events.some(event => !event || typeof event.path !== 'string' || !['added', 'modified', 'deleted'].includes(event.kind) || !Number.isFinite(event.observedAt))) throw new Error('项目文件快照无效')
    return { changes: snapshot.events.slice(-100).reverse(), lastScannedAt: typeof snapshot.scannedAt === 'number' ? snapshot.scannedAt : null, scanError: scanErrors.get(workspaceId)?.root === root ? scanErrors.get(workspaceId)!.message : null }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { changes: [], lastScannedAt: null, scanError: scanErrors.get(workspaceId)?.root === root ? scanErrors.get(workspaceId)!.message : null }
    throw error
  }
}
