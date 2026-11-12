/** 用隔离 Git index 将已核验的快照交接到新的研发工作树。 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DevelopmentSnapshot, DevelopmentSnapshotFile } from '@gravitas/shared'
import { isProtectedDevelopmentPath, normalizeRepoRelativePath, pathWithinAllowed } from './development-path-policy'

export interface OwnerDevelopmentSnapshotContent { file: DevelopmentSnapshotFile; oldContent: string | null; newContent: string | null }
export interface OwnerDevelopmentHandoffInput { snapshot: DevelopmentSnapshot; files: OwnerDevelopmentSnapshotContent[] }
const sha = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex')

/** 合并不同上游的无冲突文件或同一文件的不重叠修改；冲突时不覆盖。 */
export function mergeOwnerDevelopmentSnapshots(inputs: readonly OwnerDevelopmentHandoffInput[]): OwnerDevelopmentHandoffInput {
  if (!inputs.length) throw new Error('Owner代码交接缺少上游快照')
  const first = inputs[0]!.snapshot
  const merged = new Map<string, OwnerDevelopmentSnapshotContent>()
  for (const { snapshot, files } of inputs) {
    if (snapshot.baseCommit !== first.baseCommit || snapshot.workspaceId !== first.workspaceId || snapshot.files.length !== files.length) throw new Error('Owner代码分支基线或快照不一致')
    for (const [index, entry] of files.entries()) {
      if (JSON.stringify(entry.file) !== JSON.stringify(snapshot.files[index])
        || (entry.oldContent === null ? null : sha(entry.oldContent)) !== entry.file.oldSha256
        || (entry.newContent === null ? null : sha(entry.newContent)) !== entry.file.newSha256) throw new Error('Owner代码分支快照内容不一致')
      const previous = merged.get(entry.file.path)
      if (!previous) { merged.set(entry.file.path, entry); continue }
      if (JSON.stringify(previous.file) === JSON.stringify(entry.file) && previous.oldContent === entry.oldContent && previous.newContent === entry.newContent) continue
      if (previous.oldContent !== entry.oldContent || previous.newContent === null || entry.newContent === null) throw new Error(`Owner代码上游对同一文件产生不同修改：${entry.file.path}`)
      const directory = mkdtempSync(join(tmpdir(), 'owner-merge-'))
      try {
        const ours = join(directory, 'ours'), base = join(directory, 'base'), theirs = join(directory, 'theirs')
        writeFileSync(ours, previous.newContent); writeFileSync(base, previous.oldContent ?? ''); writeFileSync(theirs, entry.newContent)
        const result = spawnSync('git', ['merge-file', '-p', ours, base, theirs], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
        if (result.error || result.status !== 0 || !result.stdout || result.stdout.byteLength > 1024 * 1024) throw new Error(`Owner代码上游对同一文件产生不同修改：${entry.file.path}`)
        const content = result.stdout.toString('utf8')
        if (!Buffer.from(content, 'utf8').equals(result.stdout)) throw new Error('Owner代码合并结果不是完整UTF-8文本')
        merged.set(entry.file.path, { ...previous, newContent: content, file: { ...previous.file, newSha256: sha(content), newBytes: result.stdout.byteLength } })
      } finally { rmSync(directory, { recursive: true, force: true }) }
    }
  }
  const files = [...merged.values()].sort((left, right) => left.file.path.localeCompare(right.file.path))
  return { snapshot: { ...first, files: files.map(entry => entry.file) }, files }
}

/** 目标必须是尚未运行且干净的同基线工作树；Git 不得覆盖未跟踪文件。 */
export function applyOwnerDevelopmentSnapshot(worktree: string, sessionDirectory: string, snapshot: DevelopmentSnapshot, files: OwnerDevelopmentSnapshotContent[], allowedPaths: readonly string[]): void {
  const temporary = mkdtempSync(join(sessionDirectory, 'owner-handoff-'))
  const indexPath = join(temporary, 'index')
  const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete gitEnv[name]
  const git = (args: string[], input?: string | Buffer, index = false): Buffer => execFileSync('git', ['-C', worktree, ...args], {
    input, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...gitEnv, ...(index ? { GIT_INDEX_FILE: indexPath } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    if (git(['rev-parse', 'HEAD']).toString('utf8').trim() !== snapshot.baseCommit
      || git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).length) throw new Error('Owner代码交接的目标基线已变化或工作树不干净')
    if (files.length !== snapshot.files.length || !files.length) throw new Error('Owner代码交接快照文件数量不一致')
    git(['read-tree', snapshot.baseCommit], undefined, true)
    const records: Buffer[] = []
    for (const [index, entry] of files.entries()) {
      const file = entry.file, expected = snapshot.files[index]
      const path = normalizeRepoRelativePath(file.path)
      if (JSON.stringify(file) !== JSON.stringify(expected) || path !== file.path || isProtectedDevelopmentPath(path) || !pathWithinAllowed(path, allowedPaths)) throw new Error('Owner代码交接文件不在准确冻结范围内')
      if ((entry.oldContent === null ? null : sha(entry.oldContent)) !== file.oldSha256
        || (entry.newContent === null ? null : sha(entry.newContent)) !== file.newSha256) throw new Error('Owner代码交接文件内容与快照不一致')
      const treeEntry = git(['ls-tree', '-z', snapshot.baseCommit, '--', `:(literal)${path}`]).toString('utf8')
      const match = treeEntry.match(/^(100644|100755) blob [a-f0-9]{40,64}\t[^\0]+\0$/)
      if ((file.changeType === 'add' && treeEntry) || (file.changeType !== 'add' && !match)) throw new Error('Owner代码交接基线文件类型或状态不一致')
      if ((file.changeType === 'add' && (entry.oldContent !== null || entry.newContent === null))
        || (file.changeType === 'modify' && (entry.oldContent === null || entry.newContent === null))
        || (file.changeType === 'delete' && (entry.oldContent === null || entry.newContent !== null))) throw new Error('Owner代码交接变更类型无效')
      if (entry.oldContent !== null && createHash('sha256').update(git(['cat-file', 'blob', `${snapshot.baseCommit}:${path}`])).digest('hex') !== file.oldSha256) throw new Error('Owner代码交接基线正文不一致')
      if (entry.newContent === null) {
        records.push(Buffer.from(`0 ${'0'.repeat(snapshot.baseCommit.length)}\t${path}\0`))
      } else {
        const blob = git(['hash-object', '-w', '--stdin'], entry.newContent).toString('utf8').trim()
        if (!/^[a-f0-9]{40,64}$/.test(blob)) throw new Error('Owner代码交接内容无法写入Git对象')
        records.push(Buffer.from(`${match?.[1] ?? '100644'} ${blob}\t${path}\0`))
      }
    }
    git(['update-index', '-z', '--index-info'], Buffer.concat(records), true)
    const tree = git(['write-tree'], undefined, true).toString('utf8').trim()
    if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Error('Owner代码交接树对象无效')
    const patch = git(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', snapshot.baseCommit, tree, '--'], undefined, true)
    if (!patch.length) throw new Error('Owner代码交接缺少可应用变更')
    git(['apply', '--check', '--index', '-'], patch)
    git(['apply', '--index', '-'], patch)
    if (git(['write-tree']).toString('utf8').trim() !== tree) throw new Error('Owner代码交接后的工作树与冻结成果不一致')
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}
