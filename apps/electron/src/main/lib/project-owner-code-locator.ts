/** Owner 单任务代码定位：仅检索显式绑定的本地工作区，返回有界、可复核的源码片段。 */
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync, readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ProjectOwnerCodeSearchResult } from '@gravitas/shared'

export type { ProjectOwnerCodeExcerpt, ProjectOwnerCodeFileMatch, ProjectOwnerCodeSearchResult } from '@gravitas/shared'

const CODE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx', '.kt', '.m', '.mm', '.php', '.py', '.rb', '.rs', '.scala', '.scss', '.sh', '.sql', '.swift', '.ts', '.tsx', '.vue', '.xml', '.yaml', '.yml'])
const IGNORED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.turbo', '.venv', 'venv', 'target', 'Pods'])
const MAX_DEPTH = 16, MAX_FILES_SCANNED = 4000, MAX_FILE_BYTES = 256 * 1024, MAX_TOTAL_BYTES = 8 * 1024 * 1024
const MAX_RESULTS = 12, MAX_EXCERPTS_PER_FILE = 2, MAX_EXCERPT_BYTES = 700, MAX_CONTEXT_BYTES = 28 * 1024
const ordinal = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const inside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function queryTerms(query: string): string[] {
  if (typeof query !== 'string' || !query.trim() || query.length > 12000) throw new Error('代码定位目标无效或超限')
  const terms = new Set<string>()
  for (const match of query.toLowerCase().matchAll(/[a-z][a-z0-9]{2,}|[\u3400-\u9fff]{2,}/gu)) {
    const term = match[0]
    terms.add(term)
    if (/^[\u3400-\u9fff]+$/u.test(term)) for (let i = 0; i < term.length - 1; i++) terms.add(term.slice(i, i + 2))
  }
  const bilingualTerms: Array<[string, string[]]> = [
    ['报价', ['quote', 'pricing', 'price']], ['价格', ['price', 'pricing', 'amount']], ['数量', ['quantity', 'qty', 'count']],
    ['负数', ['negative', 'less than zero']], ['负', ['negative']], ['修复', ['fix', 'validate', 'handle']], ['错误', ['error', 'invalid', 'bug']],
  ]
  for (const [source, translations] of bilingualTerms) if (query.includes(source)) translations.forEach(term => terms.add(term))
  return [...terms].slice(0, 64)
}
function scoreText(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase()
  return terms.filter(term => lower.includes(term))
}
function excerptsFor(path: string, source: string, terms: string[]) {
  const lines = source.split(/\r?\n/u), hits: number[] = []
  const sensitiveLine = (line: string) => /["'`]?\b(?:api[_-]?key|secret|token|password|credential|private[_-]?key|authorization|access[_-]?key|database[_-]?url|redis[_-]?url)["'`]?[ \t]*[:=]/iu.test(line)
    || /\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu.test(line)
    || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(line)
    || /:\/\/[^/\s:@]+:[^/\s@]+@/u.test(line)
    || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u.test(line)
  const sanitizedLines = (excerpt: string): string => {
    const excerptLines = excerpt.split('\n'), hidden = new Set<number>()
    for (let index = 0; index < excerptLines.length; index++) {
      if (sensitiveLine(excerptLines[index]!)) {
        // 多行对象/环境配置常把敏感字段值放在下一行；小范围连带遮盖避免片段泄漏字段值。
        for (let offset = index; offset < Math.min(excerptLines.length, index + 4); offset++) hidden.add(offset)
      }
    }
    return excerptLines.map((line, index) => hidden.has(index) ? '[敏感配置片段已隐藏]' : line).join('\n')
  }
  for (let i = 0; i < lines.length; i++) {
    if (scoreText(lines[i]!, terms).length && !sensitiveLine(lines[i]!)) hits.push(i)
  }
  const selected: number[] = []
  for (const line of hits) {
    if (selected.every(previous => Math.abs(previous - line) > 3)) selected.push(line)
    if (selected.length >= MAX_EXCERPTS_PER_FILE) break
  }
  return selected.map(line => ({ path, line: line + 1, text: sanitizedLines(lines.slice(Math.max(0, line - 1), Math.min(lines.length, line + 2)).join('\n')).slice(0, MAX_EXCERPT_BYTES) }))
}
function readStableFile(root: string, path: string, expected: { dev: number; ino: number; size: number }): Buffer {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size) throw new Error('代码定位文件在读取期间发生变化')
  const canonicalPath = realpathSync(path)
  if (!inside(root, canonicalPath)) throw new Error('代码定位文件越出授权工作区')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_FILE_BYTES) throw new Error('代码定位文件身份或大小无效')
    const bytes = readFileSync(fd), after = lstatSync(path)
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== bytes.length || bytes.length !== opened.size) throw new Error('代码定位文件在读取期间发生变化')
    return bytes
  } finally { closeSync(fd) }
}

/** 在用户当前显式绑定的工作区内做只读检索。链接跳过，文件类型/总量有上限，不调用shell或网络。 */
export function locateOwnerCode(rootPath: string, query: string, workspaceId: string): ProjectOwnerCodeSearchResult {
  if (typeof rootPath !== 'string' || !rootPath.trim() || !isAbsolute(rootPath)) throw new Error('代码定位需要绝对路径的已授权工作区')
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 128) throw new Error('代码定位工作区身份无效')
  const terms = queryTerms(query), rootInfo = lstatSync(rootPath)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('代码定位工作区必须是普通目录')
  const root = realpathSync(rootPath)
  const rootStat = statSync(root), pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  const matches: Array<{ result: ProjectOwnerCodeSearchResult['files'][number]; score: number }> = []
  let filesScanned = 0, totalBytes = 0

  while (pending.length && filesScanned < MAX_FILES_SCANNED && totalBytes < MAX_TOTAL_BYTES) {
    const current = pending.shift()!, entries = readdirSync(current.path, { withFileTypes: true }).sort((a, b) => ordinal(a.name, b.name))
    const children: string[] = []
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const child = resolve(current.path, entry.name)
      if (!inside(root, child)) continue
      if (entry.isDirectory()) {
        if (current.depth < MAX_DEPTH && !entry.name.startsWith('.') && !IGNORED_DIRECTORIES.has(entry.name)) children.push(child)
        continue
      }
      if (!entry.isFile() || !CODE_EXTENSIONS.has(extname(entry.name).toLowerCase()) || entry.name.startsWith('.') || /(^|\.)((env|pem|key|p12|pfx|crt|cer|der)|lock)(\.|$)/iu.test(entry.name)) continue
      filesScanned++
      const metadata = lstatSync(child)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_FILE_BYTES || totalBytes + metadata.size > MAX_TOTAL_BYTES) continue
      let bytes: Buffer
      try { bytes = readStableFile(root, child, metadata) } catch (error) {
        if (error instanceof Error && /越出授权|发生变化/u.test(error.message)) continue
        throw error
      }
      totalBytes += bytes.length
      if (bytes.includes(0)) continue
      const source = bytes.toString('utf8'), path = relative(root, child).split(sep).join('/')
      const pathTerms = scoreText(path, terms), excerptList = excerptsFor(path, source, terms)
      const matchedTerms = [...new Set([...pathTerms, ...excerptList.flatMap(item => scoreText(item.text, terms))])]
      if (!matchedTerms.length) continue
      matches.push({ result: { path, sha256: createHash('sha256').update(bytes).digest('hex'), matchedTerms, excerpts: excerptList }, score: matchedTerms.length * 10 + pathTerms.length * 5 })
    }
    pending.push(...children.sort(ordinal).map(path => ({ path, depth: current.depth + 1 })))
  }

  matches.sort((a, b) => b.score - a.score || ordinal(a.result.path, b.result.path))
  const files: ProjectOwnerCodeSearchResult['files'] = []
  let contextBytes = 0, resultsTruncated = false
  for (const item of matches) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item.result))
    if (files.length >= MAX_RESULTS || contextBytes + itemBytes > MAX_CONTEXT_BYTES) { resultsTruncated = true; break }
    files.push(item.result)
    contextBytes += itemBytes
  }
  return { workspaceId, rootFingerprint: createHash('sha256').update(JSON.stringify({ device: rootStat.dev, inode: rootStat.ino })).digest('hex'), filesScanned,
    truncated: resultsTruncated || pending.length > 0 || filesScanned >= MAX_FILES_SCANNED || totalBytes >= MAX_TOTAL_BYTES, files }
}
