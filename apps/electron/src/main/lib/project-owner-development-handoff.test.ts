import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DevelopmentSnapshot, DevelopmentSnapshotFile } from '@gravitas/shared'
import { applyOwnerDevelopmentSnapshot, mergeOwnerDevelopmentSnapshots } from './project-owner-development-handoff'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owner-handoff-')), repo = join(root, 'repo'), session = join(root, 'session')
  mkdirSync(repo); mkdirSync(session); mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'old.txt'), '原文\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid'); git('add', '.'); git('commit', '-qm', 'base')
  const baseCommit = git('rev-parse', 'HEAD')
  const files: DevelopmentSnapshotFile[] = [
    { path: 'src/old.txt', changeType: 'modify', oldSha256: sha('原文\n'), newSha256: sha('新版\n'), newBytes: Buffer.byteLength('新版\n') },
    { path: 'src/new.txt', changeType: 'add', oldSha256: null, newSha256: sha('新增\n'), newBytes: Buffer.byteLength('新增\n') },
  ]
  const snapshot: DevelopmentSnapshot = { id: 'snapshot', executionId: 'exec', workspaceId: 'workspace', baseCommit, contentHash: 'a'.repeat(64), files, createdAt: 1 }
  return { root, repo, session, git, snapshot, files: [{ file: files[0]!, oldContent: '原文\n', newContent: '新版\n' }, { file: files[1]!, oldContent: null, newContent: '新增\n' }] }
}

test('Given核验的代码快照 When交接到干净同基线工作树 Then保留完整变更并可继续研发', () => {
  const f = fixture()
  try {
    applyOwnerDevelopmentSnapshot(f.repo, f.session, f.snapshot, f.files, ['src'])
    expect(readFileSync(join(f.repo, 'src/old.txt'), 'utf8')).toBe('新版\n')
    expect(readFileSync(join(f.repo, 'src/new.txt'), 'utf8')).toBe('新增\n')
    expect(f.git('diff', '--cached', '--name-only').split('\n').sort()).toEqual(['src/new.txt', 'src/old.txt'])
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
test('Given目标存在未跟踪文件或快照内容漂移 When交接 Then不覆盖用户文件', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.repo, 'src/new.txt'), '用户内容')
    expect(() => applyOwnerDevelopmentSnapshot(f.repo, f.session, f.snapshot, f.files, ['src'])).toThrow('工作树不干净')
    expect(readFileSync(join(f.repo, 'src/new.txt'), 'utf8')).toBe('用户内容')
    rmSync(join(f.repo, 'src/new.txt'))
    expect(() => applyOwnerDevelopmentSnapshot(f.repo, f.session, f.snapshot, [{ ...f.files[0]!, newContent: '篡改' }, f.files[1]!], ['src'])).toThrow('内容与快照不一致')
    expect(readFileSync(join(f.repo, 'src/old.txt'), 'utf8')).toBe('原文\n')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('Given并行分支修改不同文件 When合并冻结快照 Then保留两项变更且不允许冲突覆盖', () => {
  const f = fixture()
  try {
    const left = { snapshot: { ...f.snapshot, files: [f.snapshot.files[0]!] }, files: [f.files[0]!] }
    const right = { snapshot: { ...f.snapshot, files: [f.snapshot.files[1]!] }, files: [f.files[1]!] }
    const merged = mergeOwnerDevelopmentSnapshots([left, right])
    applyOwnerDevelopmentSnapshot(f.repo, f.session, merged.snapshot, merged.files, ['src'])
    expect(readFileSync(join(f.repo, 'src/old.txt'), 'utf8')).toBe('新版\n')
    expect(readFileSync(join(f.repo, 'src/new.txt'), 'utf8')).toBe('新增\n')
    const conflictFile = { ...f.files[0]!.file, newSha256: sha('另一版本\n'), newBytes: Buffer.byteLength('另一版本\n') }
    const conflict = { snapshot: { ...f.snapshot, files: [conflictFile] }, files: [{ file: conflictFile, oldContent: '原文\n', newContent: '另一版本\n' }] }
    expect(() => mergeOwnerDevelopmentSnapshots([left, conflict])).toThrow('同一文件产生不同修改')
    expect(() => mergeOwnerDevelopmentSnapshots([left, { ...right, snapshot: { ...right.snapshot, baseCommit: 'b'.repeat(40) } }])).toThrow('基线或快照不一致')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
test('Given两个分支修改同一文件不同位置 When合并 Then保留两方变更并生成新摘要', () => {
  const f = fixture()
  try {
    const base = '一\n二\n三\n四\n五\n六\n七\n八\n九\n'
    const leftText = '甲\n二\n三\n四\n五\n六\n七\n八\n九\n'
    const rightText = '一\n二\n三\n四\n五\n六\n七\n八\n乙\n'
    const input = (newContent: string) => {
      const file: DevelopmentSnapshotFile = { path: 'src/old.txt', changeType: 'modify', oldSha256: sha(base), newSha256: sha(newContent), newBytes: Buffer.byteLength(newContent) }
      return { snapshot: { ...f.snapshot, files: [file] }, files: [{ file, oldContent: base, newContent }] }
    }
    const result = mergeOwnerDevelopmentSnapshots([input(leftText), input(rightText)])
    expect(result.files[0]!.newContent).toBe('甲\n二\n三\n四\n五\n六\n七\n八\n乙\n')
    expect(result.files[0]!.file.newSha256).toBe(sha(result.files[0]!.newContent!))
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
