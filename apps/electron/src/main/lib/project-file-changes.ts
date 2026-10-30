/** 本地项目文件元数据快照；不读取或保存文件正文。 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { getProjectsDir } from './config-paths'

const ignored = new Set(['.git', 'node_modules', '.next', '.nuxt', 'dist', 'build', '.cache', '__pycache__', '.turbo', '.parcel-cache', '.svelte-kit'])
const MAX_FILES = 20000
const MAX_EVENTS = 1000

interface FileMetadata { size: number; modified: number }
export interface ProjectFileChange { path: string; kind: 'added' | 'modified' | 'deleted'; observedAt: number }
interface Snapshot { version: 1; root: string; files: Record<string, FileMetadata>; events: ProjectFileChange[] }

function snapshotPath(workspaceId: string): string {
  const key = createHash('sha256').update(workspaceId).digest('hex')
  return join(getProjectsDir(), 'file-changes', `${key}.json`)
}

async function collect(root: string): Promise<Record<string, FileMetadata>> {
  const files: Record<string, FileMetadata> = Object.create(null)
  let count = 0
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        if (++count > MAX_FILES) throw new Error('文件数量超过项目变化扫描上限')
        const info = await stat(path)
        files[relative(root, path).replace(/\\/g, '/')] = { size: info.size, modified: info.mtimeMs }
      }
    }
  }
  await visit(root)
  return files
}

/** 扫描失败时不写入快照，避免把不可读目录误判为文件删除。首次扫描仅建立基线。 */
export async function scanProjectFileChanges(workspaceId: string, root: string): Promise<ProjectFileChange[]> {
  const path = snapshotPath(workspaceId)
  let previous: Snapshot | undefined
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1 || !('root' in value) || value.root !== root || !('files' in value) || typeof value.files !== 'object' || value.files === null || !('events' in value) || !Array.isArray(value.events)) throw new Error('项目文件快照无效')
    previous = value as Snapshot
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const files = await collect(root)
  const now = Date.now()
  const changes: ProjectFileChange[] = []
  if (previous) {
    for (const [name, info] of Object.entries(files)) {
      const old = Object.hasOwn(previous.files, name) ? previous.files[name] : undefined
      if (!old) changes.push({ path: name, kind: 'added', observedAt: now })
      else if (old.size !== info.size || old.modified !== info.modified) changes.push({ path: name, kind: 'modified', observedAt: now })
    }
    for (const name of Object.keys(previous.files)) if (!files[name]) changes.push({ path: name, kind: 'deleted', observedAt: now })
  }
  const next: Snapshot = { version: 1, root, files, events: [...(previous?.events ?? []), ...changes].slice(-MAX_EVENTS) }
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
