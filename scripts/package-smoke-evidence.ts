/** 只导出隔离冒烟的项目证据与成果，不复制渠道、钥匙串、Skills 或 MCP 配置。 */
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

interface EvidenceFile { path: string; bytes: number; sha256: string }
const MAX_BYTES = 256 * 1024 * 1024

function included(path: string): boolean {
  const parts = path.split('/')
  if (parts.some(part => part.startsWith('.') || part === 'node_modules')) return false
  if (path === 'owner-real-chain-report.json') return true
  if (/^projects\/paa\.db(?:-wal|-shm)?$/.test(path)) return true
  if (/^agent-sessions\/[^/]+\.jsonl$/.test(path)) return true
  if (parts[0] !== 'agent-workspaces' || parts.length < 4) return false
  return parts[3] === 'source' || /^development-(?:snapshot-|validation-|evidence-|worktree\.json$)/.test(parts[3]!) || /^owner-development-validation-attempt-.+\.json$/.test(parts[3]!)
}

export function resolvePackageSmokeEvidenceDestination(profile: string, destination: string): string {
  const source = realpathSync(profile), requested = resolve(destination)
  let parent = dirname(requested)
  while (!existsSync(parent)) parent = dirname(parent)
  const target = resolve(realpathSync(parent), relative(parent, requested))
  const overlaps = (parent: string, child: string) => {
    const path = relative(parent, child)
    return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
  }
  if (!isAbsolute(destination) || overlaps(source, target) || overlaps(target, source) || existsSync(target)) {
    throw new Error('冒烟证据目录必须是 profile 之外尚不存在的绝对路径')
  }
  return target
}

export function exportPackageSmokeEvidence(profile: string, destination: string): EvidenceFile[] {
  const source = realpathSync(profile), target = resolvePackageSmokeEvidenceDestination(profile, destination)
  const files: EvidenceFile[] = []
  let total = 0
  mkdirSync(target, { recursive: true, mode: 0o700 })
  const visit = (directory: string, prefix = ''): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!prefix && !['projects', 'agent-sessions', 'agent-workspaces', 'owner-real-chain-report.json'].includes(entry.name)) continue
      const parts = path.split('/')
      if (parts[0] === 'projects' && parts.length > 1 && !included(path)) continue
      if (parts[0] === 'agent-sessions' && parts.length > 1 && !included(path)) continue
      if (parts[0] === 'agent-workspaces' && parts.length === 3 && !/^[a-f0-9-]{36}$/i.test(entry.name)) continue
      if (parts[0] === 'agent-workspaces' && parts.length >= 4 && !included(path)) continue
      const input = join(directory, entry.name)
      const stat = lstatSync(input)
      if (stat.isSymbolicLink()) throw new Error(`冒烟证据含符号链接，停止导出并保留原 profile：${path}`)
      if (stat.isDirectory()) { visit(input, path); continue }
      if (!included(path)) continue
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024 || total + stat.size > MAX_BYTES) throw new Error('冒烟证据文件类型或大小不符合导出边界')
      const descriptor = openSync(input, constants.O_RDONLY | constants.O_NOFOLLOW)
      let data: Buffer
      try {
        const opened = fstatSync(descriptor)
        if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new Error('冒烟证据在读取前变化，保留原 profile')
        data = readFileSync(descriptor)
        if (data.length !== stat.size) throw new Error('冒烟证据在读取时变化，保留原 profile')
      } finally { closeSync(descriptor) }
      total += data.length
      const output = join(target, ...path.split('/'))
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
      writeFileSync(output, data, { flag: 'wx', mode: 0o600 })
      files.push({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
    }
  }
  visit(source)
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({ version: 1, restoreSupported: false, exportedAt: new Date().toISOString(), files }, null, 2), { flag: 'wx', mode: 0o600 })
  return files
}
