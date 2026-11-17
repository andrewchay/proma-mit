import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectDevelopmentWorkspaceBlocker } from './development-workspace-blocker'

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'dev-blocker-'))
  execFileSync('git', ['-C', root, 'init', '-q'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@e.invalid'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 't'])
  writeFileSync(join(root, 'a.txt'), 'a\n')
  execFileSync('git', ['-C', root, 'add', '.'])
  execFileSync('git', ['-C', root, 'commit', '-qm', 'base'])
  return root
}

test('Given干净仓库 When检查 Then没有阻塞项', () => {
  const root = repo()
  try { expect(inspectDevelopmentWorkspaceBlocker(root, 'ws-1', '产品仓')).toEqual({ kind: 'ready' }) }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('Given已跟踪与未跟踪改动 When检查 Then分别列出安全相对路径与处理方式', () => {
  const root = repo()
  try {
    writeFileSync(join(root, 'a.txt'), 'changed\n')
    writeFileSync(join(root, 'new.txt'), 'new\n')
    const blocker = inspectDevelopmentWorkspaceBlocker(root, 'ws-1', '产品仓')
    expect(blocker).toMatchObject({
      kind: 'dirty_worktree', workspaceId: 'ws-1', workspaceName: '产品仓',
      trackedFiles: ['a.txt'], untrackedFiles: ['new.txt'],
    })
    if (blocker.kind !== 'dirty_worktree') throw new Error('unreachable')
    expect(blocker.remedy).toContain('不会自动提交或丢弃')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Given只修改已跟踪文件 When检查 Then未跟踪列表为空', () => {
  const root = repo()
  try {
    writeFileSync(join(root, 'a.txt'), 'changed\n')
    const blocker = inspectDevelopmentWorkspaceBlocker(root, 'ws-1', '产品仓')
    expect(blocker).toMatchObject({ kind: 'dirty_worktree', trackedFiles: ['a.txt'], untrackedFiles: [] })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Given只有未跟踪文件 When检查 Then已跟踪列表为空', () => {
  const root = repo()
  try {
    writeFileSync(join(root, 'new.txt'), 'new\n')
    const blocker = inspectDevelopmentWorkspaceBlocker(root, 'ws-1', '产品仓')
    expect(blocker).toMatchObject({ kind: 'dirty_worktree', trackedFiles: [], untrackedFiles: ['new.txt'] })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Given目录不是Git仓库 When检查 Then报告not_git_root而不是崩溃', () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-blocker-plain-'))
  try {
    expect(inspectDevelopmentWorkspaceBlocker(root, 'ws-1', '产品仓')).toMatchObject({ kind: 'not_git_root' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Given目录不存在 When检查 Then报告not_git_root而不是抛错', () => {
  expect(inspectDevelopmentWorkspaceBlocker('/nonexistent/definitely/not/here', 'ws-1', '产品仓'))
    .toMatchObject({ kind: 'not_git_root' })
})

test('Given路径是子目录 When检查 Then报告not_git_root并说明根目录', () => {
  const root = repo()
  try {
    mkdirSync(join(root, 'sub'))
    const blocker = inspectDevelopmentWorkspaceBlocker(join(root, 'sub'), 'ws-1', '产品仓')
    expect(blocker).toMatchObject({ kind: 'not_git_root' })
    if (blocker.kind !== 'not_git_root') throw new Error('unreachable')
    expect(blocker.detail).toContain('不是仓库根目录')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Given改动文件超过上限 When检查 Then列表被截断但不崩溃', () => {
  const root = repo()
  try {
    for (let i = 0; i < 40; i++) writeFileSync(join(root, `f${i}.txt`), `${i}\n`)
    const blocker = inspectDevelopmentWorkspaceBlocker(root, 'ws-1', '产品仓')
    expect(blocker).toMatchObject({ kind: 'dirty_worktree' })
    if (blocker.kind !== 'dirty_worktree') throw new Error('unreachable')
    expect(blocker.untrackedFiles.length).toBeLessThanOrEqual(30)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Given工作区清理后 When检查 Then恢复ready且不再报告文件清单', () => {
  const root = repo()
  try {
    writeFileSync(join(root, 'a.txt'), 'changed\n')
    expect(inspectDevelopmentWorkspaceBlocker(root, 'ws-1', '产品仓')).toMatchObject({ kind: 'dirty_worktree' })
    execFileSync('git', ['-C', root, 'checkout', '--', 'a.txt'])
    expect(inspectDevelopmentWorkspaceBlocker(root, 'ws-1', '产品仓')).toEqual({ kind: 'ready' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
