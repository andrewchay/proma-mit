import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDevelopmentWorktree, resolveDevelopmentWorktree } from './agent-development-worktree'

let root: string
let repo: string
let session: string
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gravitas-rd-'))
  repo = join(root, 'repo'); session = join(root, 'session'); mkdirSync(repo); mkdirSync(session)
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(repo, 'source.ts'), 'original'); git('add', '.'); git('commit', '-m', 'initial')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('研发任务 Git 隔离', () => {
  test('Given 干净仓库 When 创建任务目录 Then 改动不污染原目录且绑定可恢复', () => {
    const result = createDevelopmentWorktree(repo, session, 'run-1')
    writeFileSync(join(result.path, 'source.ts'), 'changed')
    expect(readFileSync(join(repo, 'source.ts'), 'utf8')).toBe('original')
    expect(resolveDevelopmentWorktree(repo, session)).toBe(result.path)
    expect(git('status', '--porcelain')).toBe('')
  })
  test('Given 未提交改动 When 创建 Then 拒绝而非忽略当前迭代', () => {
    writeFileSync(join(repo, 'source.ts'), 'unfinished')
    expect(() => createDevelopmentWorktree(repo, session, 'run-2')).toThrow('未提交')
  })
  test('Given 已绑定但目录消失 When 恢复 Then 不静默回退主仓库', () => {
    const result = createDevelopmentWorktree(repo, session, 'run-3')
    rmSync(result.path, { recursive: true, force: true })
    expect(() => resolveDevelopmentWorktree(repo, session)).toThrow()
  })
  test('Given 普通会话 When 解析 Then 不改变既有 cwd', () => {
    expect(resolveDevelopmentWorktree(repo, session)).toBeUndefined()
  })
  test('Given 工作区被换绑 When 恢复 Then 拒绝旧绑定', () => {
    createDevelopmentWorktree(repo, session, 'run-4')
    const other = join(root, 'other'); mkdirSync(other)
    expect(() => resolveDevelopmentWorktree(other, session)).toThrow('仓库')
  })
})
