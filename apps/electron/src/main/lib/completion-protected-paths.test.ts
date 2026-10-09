import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assessProtectedPathChanges, matchesProtectedPath } from './completion-protected-paths'

const root = mkdtempSync(join(tmpdir(), 'gravitas-protected-paths-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('受保护路径模式', () => {
  test('**/*.test.ts 匹配任意深度的测试文件，不匹配普通源码', () => {
    expect(matchesProtectedPath('**/*.test.ts', 'a.test.ts')).toBe(true)
    expect(matchesProtectedPath('**/*.test.ts', 'apps/x/y/z.test.ts')).toBe(true)
    expect(matchesProtectedPath('**/*.test.ts', 'apps/x/y/z.ts')).toBe(false)
    expect(matchesProtectedPath('**/*.test.ts', 'apps/x/y/z.test.tsx')).toBe(false)
  })
  test('目录前缀与精确路径', () => {
    expect(matchesProtectedPath('tests/', 'tests/unit/a.ts')).toBe(true)
    expect(matchesProtectedPath('tests/', 'testsuite/a.ts')).toBe(false)
    expect(matchesProtectedPath('fixtures/golden.json', 'fixtures/golden.json')).toBe(true)
    expect(matchesProtectedPath('fixtures/golden.json', 'fixtures/golden.json.bak')).toBe(false)
  })
  test('单段星号不跨越目录；空模式与前导 ./ 处理', () => {
    expect(matchesProtectedPath('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matchesProtectedPath('src/*.ts', 'src/deep/a.ts')).toBe(false)
    expect(matchesProtectedPath('./tests/', 'tests/a.ts')).toBe(true)
  })
  test('非法模式（空、绝对路径、..）拒绝', () => {
    expect(() => matchesProtectedPath('', 'a')).toThrow('protectedPaths')
    expect(() => matchesProtectedPath('/etc/x', 'a')).toThrow('protectedPaths')
    expect(() => matchesProtectedPath('../x', 'a')).toThrow('protectedPaths')
  })
})

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=f', '-c', 'user.email=f@x', ...args], { encoding: 'utf8' }).trim()
}
function repoWith(name: string): string {
  const repo = join(root, name)
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, 'tests'), { recursive: true })
  git(repo, ['init', '-q'])
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1\n')
  writeFileSync(join(repo, 'tests/a.test.ts'), 'test("a", () => {})\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'base'])
  return repo
}
const PATTERNS = ['**/*.test.ts', 'tests/']

describe('基线之后的受保护路径改动检查', () => {
  test('只改源码的后续提交允许完成', async () => {
    const repo = repoWith('src-only')
    const base = git(repo, ['rev-parse', 'HEAD'])
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2\n')
    git(repo, ['commit', '-q', '-am', 'fix'])
    const result = await assessProtectedPathChanges({ repoRoot: repo, baselineCommitSha: base, headCommitSha: git(repo, ['rev-parse', 'HEAD']), protectedPaths: PATTERNS })
    expect(result).toEqual({ ok: true, reasons: [], violations: [] })
  })
  test('提交修改测试文件（削弱断言）被拒绝并列出违规路径', async () => {
    const repo = repoWith('weaken')
    const base = git(repo, ['rev-parse', 'HEAD'])
    writeFileSync(join(repo, 'tests/a.test.ts'), 'test("a", () => {})\n// 削弱\n')
    git(repo, ['commit', '-q', '-am', 'weaken'])
    const result = await assessProtectedPathChanges({ repoRoot: repo, baselineCommitSha: base, headCommitSha: git(repo, ['rev-parse', 'HEAD']), protectedPaths: PATTERNS })
    expect(result.ok).toBe(false)
    expect(result.reasons).toContain('protected_paths_changed')
    expect(result.violations).toEqual(['tests/a.test.ts'])
  })
  test('删除受保护测试文件同样被拒绝（不做重命名折叠）', async () => {
    const repo = repoWith('delete')
    const base = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['rm', '-q', 'tests/a.test.ts'])
    git(repo, ['commit', '-q', '-m', 'delete test'])
    const result = await assessProtectedPathChanges({ repoRoot: repo, baselineCommitSha: base, headCommitSha: git(repo, ['rev-parse', 'HEAD']), protectedPaths: PATTERNS })
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual(['tests/a.test.ts'])
  })
  test('把测试内容移动到非受保护路径，旧路径仍报告违规', async () => {
    const repo = repoWith('move')
    const base = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['mv', 'tests/a.test.ts', 'src/moved.ts'])
    git(repo, ['commit', '-q', '-m', 'move'])
    const result = await assessProtectedPathChanges({ repoRoot: repo, baselineCommitSha: base, headCommitSha: git(repo, ['rev-parse', 'HEAD']), protectedPaths: PATTERNS })
    expect(result.ok).toBe(false)
    expect(result.violations).toContain('tests/a.test.ts')
  })
  test('基线不是 HEAD 的祖先（分叉/重写历史）拒绝', async () => {
    const repo = repoWith('diverged')
    const base = git(repo, ['rev-parse', 'HEAD'])
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 9\n')
    git(repo, ['commit', '-q', '-am', 'head-line'])
    const head = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['checkout', '-q', '-b', 'other', base])
    writeFileSync(join(repo, 'src/b.ts'), 'export const b = 1\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'other'])
    const otherBase = git(repo, ['rev-parse', 'HEAD'])
    const result = await assessProtectedPathChanges({ repoRoot: repo, baselineCommitSha: otherBase, headCommitSha: head, protectedPaths: PATTERNS })
    expect(result.ok).toBe(false)
    expect(result.reasons).toContain('baseline_not_ancestor')
  })
  test('基线与HEAD相同时没有改动，允许', async () => {
    const repo = repoWith('same')
    const head = git(repo, ['rev-parse', 'HEAD'])
    expect((await assessProtectedPathChanges({ repoRoot: repo, baselineCommitSha: head, headCommitSha: head, protectedPaths: PATTERNS })).ok).toBe(true)
  })
  test('未提交的工作树修改不计入（只比较提交）', async () => {
    const repo = repoWith('dirty')
    const base = git(repo, ['rev-parse', 'HEAD'])
    writeFileSync(join(repo, 'tests/a.test.ts'), 'uncommitted\n')
    expect((await assessProtectedPathChanges({ repoRoot: repo, baselineCommitSha: base, headCommitSha: base, protectedPaths: PATTERNS })).ok).toBe(true)
  })
})
