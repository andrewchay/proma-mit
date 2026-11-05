import { afterAll, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

test('Given 不安全名称 When 创建工作区 Then 拒绝且不在受管目录外建仓', () => {
  for (const name of ['../escaped', '../../escaped', 'a/b', 'a\\b', '.', '..']) {
    expect(() => createOwnerDedicatedWorkspace(name)).toThrow('Owner工作区名称无效')
  }
  expect(existsSync(join(getConfigDir(), 'escaped'))).toBe(false)
})

;(process.platform === 'win32' ? test.skip : test)('Given 进程携带 Git 模板及配置 When 初始化工作区 Then 不执行模板 hook', () => {
  const template = join(directory, 'git-template')
  const hooks = join(template, 'hooks')
  const marker = join(directory, 'hook-executed')
  mkdirSync(hooks, { recursive: true })
  const hook = join(hooks, 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\nprintf invoked > "$OWNER_HOOK_MARKER"\n')
  chmodSync(hook, 0o755)
  const oldTemplate = process.env.GIT_TEMPLATE_DIR
  const oldMarker = process.env.OWNER_HOOK_MARKER
  process.env.GIT_TEMPLATE_DIR = template
  process.env.OWNER_HOOK_MARKER = marker
  try {
    const workspace = createOwnerDedicatedWorkspace('owner-git-hook-isolation')
    expect(isGitRepositoryWithHead(workspace.rootPath!)).toBe(true)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(workspace.rootPath!, '.git', 'hooks', 'pre-commit'))).toBe(false)
  } finally {
    if (oldTemplate === undefined) delete process.env.GIT_TEMPLATE_DIR; else process.env.GIT_TEMPLATE_DIR = oldTemplate
    if (oldMarker === undefined) delete process.env.OWNER_HOOK_MARKER; else process.env.OWNER_HOOK_MARKER = oldMarker
  }
})

;(process.platform === 'win32' ? test.skip : test)('Given 中断的仓库含 hook When 恢复基线 Then 不执行 hook 且保留原文件', () => {
  const repo = join(getConfigDir(), 'owner-dev-repos', 'owner-existing-hook')
  const marker = join(directory, 'existing-hook-executed')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['-C', repo, 'init', '-q'])
  const hook = join(repo, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\nprintf invoked > "$OWNER_EXISTING_HOOK_MARKER"\n')
  chmodSync(hook, 0o755)
  const previousMarker = process.env.OWNER_EXISTING_HOOK_MARKER
  process.env.OWNER_EXISTING_HOOK_MARKER = marker
  try {
    const workspace = createOwnerDedicatedWorkspace('owner-existing-hook')
    expect(isGitRepositoryWithHead(workspace.rootPath!)).toBe(true)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(hook)).toBe(true)
  } finally {
    if (previousMarker === undefined) delete process.env.OWNER_EXISTING_HOOK_MARKER; else process.env.OWNER_EXISTING_HOOK_MARKER = previousMarker
  }
})

test('Given 工作区目录是符号链接 When 创建 Then 拒绝且不在目标目录建仓', () => {
  const target = join(directory, 'link-target')
  const parent = join(getConfigDir(), 'owner-dev-repos')
  mkdirSync(target, { recursive: true })
  mkdirSync(parent, { recursive: true })
  symlinkSync(target, join(parent, 'owner-link'))
  expect(() => createOwnerDedicatedWorkspace('owner-link')).toThrow('Owner工作区目录不安全')
  expect(existsSync(join(target, '.git'))).toBe(false)
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
