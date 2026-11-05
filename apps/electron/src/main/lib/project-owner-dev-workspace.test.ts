import { afterAll, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-dev-workspace-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())

const { createOwnerDedicatedWorkspace, isGitRepositoryWithHead } = await import('./project-owner-dev-workspace')
const { getConfigDir } = await import('./config-paths')

afterAll(() => {
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

test('Given Git可用 When 创建Owner专用工作区 Then 工作区落在受管目录且HEAD可解析', () => {
  const workspace = createOwnerDedicatedWorkspace('Owner-abcdef12-000001')
  const repoRoot = realpathSync(join(getConfigDir(), 'owner-dev-repos', 'owner-abcdef12-000001'))
  expect(workspace.slug).toBe('owner-abcdef12-000001')
  expect(workspace.rootPath).toBe(repoRoot)
  expect(isGitRepositoryWithHead(workspace.rootPath!)).toBe(true)
  // 基线是空初始提交，不预置业务文件。
  const files = execFileSync('git', ['-C', repoRoot, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }).trim()
  expect(files).toBe('')
})

test('Given 上次中断留下半成品仓库 When 再次创建 Then 补齐基线而不是永久回退', () => {
  const repoRoot = join(getConfigDir(), 'owner-dev-repos', 'owner-abcdef12-000002')
  mkdirSync(repoRoot, { recursive: true })
  execFileSync('git', ['-C', repoRoot, 'init', '-q'])
  expect(isGitRepositoryWithHead(repoRoot)).toBe(false)
  const workspace = createOwnerDedicatedWorkspace('Owner-abcdef12-000002')
  expect(workspace.rootPath).toBe(realpathSync(repoRoot))
  expect(isGitRepositoryWithHead(workspace.rootPath!)).toBe(true)
})

test('Given 名称空白或超长 When 创建Owner专用工作区 Then 拒绝且不产生目录', () => {
  expect(() => createOwnerDedicatedWorkspace('   ')).toThrow('Owner工作区名称无效')
  expect(() => createOwnerDedicatedWorkspace(`Owner-${'x'.repeat(101)}`)).toThrow('Owner工作区名称无效')
})

test('Given 同名工作区已存在 When 再次创建 Then 重名错误原样抛出而不是静默降级', () => {
  createOwnerDedicatedWorkspace('Owner-abcdef12-000004')
  expect(() => createOwnerDedicatedWorkspace('Owner-abcdef12-000004')).toThrow('已存在')
})

test('Given Git不可用 When 创建Owner专用工作区 Then 回退为无rootPath托管工作区', () => {
  const path = process.env.PATH
  const emptyBin = join(directory, 'empty-bin')
  mkdirSync(emptyBin, { recursive: true })
  process.env.PATH = emptyBin
  try {
    const workspace = createOwnerDedicatedWorkspace('Owner-abcdef12-000005')
    expect(workspace.rootPath).toBeUndefined()
    expect(workspace.slug).toBe('owner-abcdef12-000005')
  } finally {
    process.env.PATH = path
  }
})
