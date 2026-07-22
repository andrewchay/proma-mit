import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import type { AgentRuntimeScope } from './agent-runtime-server'
import type { AgentRuntimeObjectRef, AgentRuntimeObjectStore } from './agent-runtime-object-storage'
import {
  createAgentRuntimeWorkspaceObjectKey,
  createAgentRuntimeWorkspaceObjectPrefix,
} from './agent-runtime-object-storage'

export interface AgentRuntimeWorkspaceSyncScope extends AgentRuntimeScope {
  workspaceSlug: string
}

export interface MaterializeAgentRuntimeWorkspaceInput extends AgentRuntimeWorkspaceSyncScope {
  objectStore: AgentRuntimeObjectStore
  localDir: string
  limit?: number
}

export interface SyncAgentRuntimeWorkspaceInput extends AgentRuntimeWorkspaceSyncScope {
  objectStore: AgentRuntimeObjectStore
  localDir: string
  contentType?: string
}

export interface AgentRuntimeWorkspaceSyncResult {
  files: AgentRuntimeObjectRef[]
}

export async function materializeAgentRuntimeWorkspace(
  input: MaterializeAgentRuntimeWorkspaceInput,
): Promise<AgentRuntimeWorkspaceSyncResult> {
  const root = resolve(input.localDir)
  await mkdir(root, { recursive: true })
  const prefix = createAgentRuntimeWorkspaceObjectPrefix(input, input.workspaceSlug)
  const objects = await input.objectStore.listObjects({ prefix: `${prefix}/`, limit: input.limit })
  const written: AgentRuntimeObjectRef[] = []

  for (const object of objects) {
    const stored = await input.objectStore.getObject(object.key)
    if (!stored) continue
    const target = safeJoin(root, decodeRelativeObjectSuffix(prefix, object.key))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, stored.body)
    written.push(object)
  }

  return { files: written }
}

export async function syncAgentRuntimeWorkspaceToObjectStore(
  input: SyncAgentRuntimeWorkspaceInput,
): Promise<AgentRuntimeWorkspaceSyncResult> {
  const root = resolve(input.localDir)
  const relativePaths = await listWorkspaceFiles(root)
  const uploaded: AgentRuntimeObjectRef[] = []

  for (const relativePath of relativePaths) {
    const filePath = safeJoin(root, relativePath)
    const key = createAgentRuntimeWorkspaceObjectKey({
      tenantId: input.tenantId,
      userId: input.userId,
      workspaceSlug: input.workspaceSlug,
      relativePath,
    })
    uploaded.push(await input.objectStore.putObject({
      key,
      body: new Uint8Array(await readFile(filePath)),
      contentType: input.contentType,
    }))
  }

  return { files: uploaded }
}

async function listWorkspaceFiles(root: string): Promise<string[]> {
  const files: string[] = []

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = resolve(current, entry.name)
      const relativePath = toPortableRelativePath(root, fullPath)
      if (entry.isSymbolicLink()) {
        throw new Error(`工作区同步拒绝 symlink: ${relativePath}`)
      }
      if (entry.isDirectory()) {
        await visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      const fileStat = await stat(fullPath)
      if (!fileStat.isFile()) continue
      files.push(relativePath)
    }
  }

  await visit(root)
  return files.sort((left, right) => left.localeCompare(right))
}

function decodeRelativeObjectSuffix(prefix: string, key: string): string {
  const expectedPrefix = `${prefix}/`
  if (!key.startsWith(expectedPrefix)) {
    throw new Error('对象 key 不属于当前工作区前缀')
  }
  const suffix = key.slice(expectedPrefix.length)
  const parts = suffix.split('/').map((part) => decodeURIComponent(part))
  if (
    parts.length === 0 ||
    parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('/') || part.includes('\\'))
  ) {
    throw new Error('对象 key 包含不安全路径片段')
  }
  return parts.join('/')
}

function safeJoin(root: string, relativePath: string): string {
  const target = resolve(root, relativePath)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('工作区路径越界')
  }
  return target
}

function toPortableRelativePath(root: string, filePath: string): string {
  const rel = relative(root, filePath)
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new Error('工作区路径越界')
  }
  return rel.split(sep).join('/')
}
