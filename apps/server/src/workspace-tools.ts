import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { jsonSchema, tool } from 'ai'
import type { ToolSet } from 'ai'

const MAX_FILE_BYTES = 512 * 1024
const MAX_LIST_ENTRIES = 500

/** 为 Web worker 提供只读、工作区边界内的工具；不暴露宿主机 Shell。 */
export function createWorkspaceReadTools(workspaceRoot: string): ToolSet {
  return {
    ListWorkspaceFiles: tool({
      description: '列出工作区内指定目录的文件和目录。只能访问当前工作区。',
      inputSchema: jsonSchema<{ path?: string }>({
        type: 'object', properties: { path: { type: 'string', description: '相对工作区的目录，默认为根目录' } }, additionalProperties: false,
      }),
      execute: async ({ path }) => JSON.stringify(await listWorkspaceFiles(workspaceRoot, path ?? '')),
    }),
    ReadWorkspaceFile: tool({
      description: '读取工作区内的 UTF-8 文本文件，单次最多 512 KiB。只能访问当前工作区。',
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object', required: ['path'], properties: { path: { type: 'string', description: '相对工作区的文件路径' } }, additionalProperties: false,
      }),
      execute: async ({ path }) => readWorkspaceFile(workspaceRoot, path),
    }),
  }
}

export function createWorkspaceWriteTool(workspaceRoot: string, execute: (path: string, content: string) => Promise<string>): ToolSet {
  return {
    WriteWorkspaceFile: tool({
      description: '写入当前工作区中已有目录内的 UTF-8 文本文件。该操作需要用户审批。',
      inputSchema: jsonSchema<{ path: string; content: string }>({
        type: 'object', required: ['path', 'content'], properties: {
          path: { type: 'string', description: '相对工作区的文件路径' }, content: { type: 'string', description: '完整文件内容' },
        }, additionalProperties: false,
      }),
      execute: async ({ path, content }) => execute(path, content),
    }),
  }
}

export interface WorkspaceFileEntry {
  path: string
  kind: 'file' | 'directory'
  size?: number
}

export async function listWorkspaceFiles(workspaceRoot: string, relativePath: string): Promise<WorkspaceFileEntry[]> {
  const directory = await resolveWorkspacePath(workspaceRoot, relativePath)
  const entries = await readdir(directory, { withFileTypes: true })
  const result: WorkspaceFileEntry[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (result.length >= MAX_LIST_ENTRIES) break
    if (entry.isSymbolicLink()) continue
    const path = relativePath ? `${relativePath.replace(/\\/g, '/')}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      result.push({ path, kind: 'directory' })
    } else if (entry.isFile()) {
      const metadata = await lstat(resolve(directory, entry.name))
      result.push({ path, kind: 'file', size: metadata.size })
    }
  }
  return result
}

export async function readWorkspaceFile(workspaceRoot: string, relativePath: string): Promise<string> {
  const path = await resolveWorkspacePath(workspaceRoot, relativePath)
  const metadata = await lstat(path)
  if (!metadata.isFile()) throw new Error('只能读取普通文件')
  if (metadata.size > MAX_FILE_BYTES) throw new Error(`文件超过 ${MAX_FILE_BYTES} 字节读取上限`)
  return readFile(path, 'utf8')
}

export async function writeWorkspaceFile(workspaceRoot: string, relativePath: string, content: string): Promise<string> {
  const target = await resolveWorkspaceWritePath(workspaceRoot, relativePath)
  await writeFile(target, content, 'utf8')
  return `已写入 ${relativePath}（${Buffer.byteLength(content, 'utf8')} 字节）`
}

async function resolveWorkspacePath(workspaceRoot: string, candidate: string): Promise<string> {
  if (candidate.includes('\u0000')) throw new Error('工作区路径不能包含空字符')
  const root = await realpath(workspaceRoot)
  const target = resolve(root, candidate)
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('路径超出工作区范围')
  const resolved = await realpath(target)
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) throw new Error('符号链接不能指向工作区外')
  return resolved
}

async function resolveWorkspaceWritePath(workspaceRoot: string, candidate: string): Promise<string> {
  if (!candidate || candidate.includes('\u0000')) throw new Error('工作区路径不能为空且不能包含空字符')
  const root = await realpath(workspaceRoot)
  const target = resolve(root, candidate)
  if (!target.startsWith(`${root}${sep}`)) throw new Error('路径超出工作区范围')
  const parent = await realpath(dirname(target))
  if (parent !== root && !parent.startsWith(`${root}${sep}`)) throw new Error('符号链接不能指向工作区外')
  try {
    const existing = await lstat(target)
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('只能写入普通文件')
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  return target
}
