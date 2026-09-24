/**
 * W01：研发任务范围与预检服务的 BDD 契约（T01/T03/T04 范围部分、T02 关联）。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-rd-scope-'))
const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = join(directory, 'config')
mock.module('electron', () => buildElectronMock())

function tempRepoDir(tag: string): string {
  const dir = join(directory, `${tag}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const store = await import('./project-sqlite-store')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const {
  normalizeRepoRelativePath,
  isProtectedDevelopmentPath,
  pathWithinAllowed,
  validateDevelopmentScope,
  setTaskDevelopmentScope,
  resolveDevelopmentDispatchScope,
} = await import('./development-task-service')

beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  store.closeProjectDb()
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(directory, { recursive: true, force: true })
})

describe('路径清洗（T04 范围层）', () => {
  test('Given 绝对路径/..序列/NUL/反斜杠/空段 When 清洗 Then 全部拒绝', () => {
    for (const bad of ['/etc/passwd', 'a/../b', '../escape', 'a\0b', 'src\\a.ts', 'a//b', 'src/', './a', 'C:/x', '']) {
      expect(() => normalizeRepoRelativePath(bad)).toThrow()
    }
    expect(normalizeRepoRelativePath(' src/a.ts ')).toBe('src/a.ts')
    expect(normalizeRepoRelativePath('docs/中文 说明.md')).toBe('docs/中文 说明.md')
  })

  test('Given 受保护路径 When 判定 Then 命中默认禁止清单', () => {
    for (const p of ['.env', '.env.local', 'AGENTS.md', '.context/plan/x.md', 'bun.lock', 'package-lock.json', 'server.key', 'a/credentials.json', 'a/secrets/token.txt', 'a/id_rsa_gh']) {
      expect(isProtectedDevelopmentPath(p)).toBe(true)
    }
    expect(isProtectedDevelopmentPath('src/a.ts')).toBe(false)
    expect(isProtectedDevelopmentPath('docs/usage.md')).toBe(false)
  })

  test('Given 允许前缀 When 判定包含关系 Then 按路径段匹配不误判', () => {
    expect(pathWithinAllowed('src/a.ts', ['src'])).toBe(true)
    expect(pathWithinAllowed('src/sub/a.ts', ['src'])).toBe(true)
    expect(pathWithinAllowed('srcx/a.ts', ['src'])).toBe(false)
    expect(pathWithinAllowed('src', ['src'])).toBe(true)
  })
})

describe('范围校验', () => {
  test('Given 缺工作区/无 rootPath When 校验 Then 拒绝', () => {
    expect(() => validateDevelopmentScope({ workspaceId: 'nope', targetPaths: ['a.ts'], allowedPaths: ['.'] }, { getWorkspace: () => undefined })).toThrow('不存在')
    const noRoot = createAgentWorkspace(`no-root-${Math.random().toString(36).slice(2, 8)}`)
    expect(() => validateDevelopmentScope({ workspaceId: noRoot.id, targetPaths: ['a.ts'], allowedPaths: ['.'] }, { getWorkspace: (id) => id === noRoot.id ? noRoot : undefined })).toThrow('Git 仓库')
  })

  test('Given 目标超出允许范围或命中保护清单 When 校验 Then 拒绝', () => {
    const ws = createAgentWorkspace(`scope-${Math.random().toString(36).slice(2, 8)}`, tempRepoDir('scope'))
    const facts = { getWorkspace: (id: string) => id === ws.id ? ws : undefined }
    expect(() => validateDevelopmentScope({ workspaceId: ws.id, targetPaths: ['lib/a.ts'], allowedPaths: ['src'] }, facts)).toThrow('允许修改范围')
    expect(() => validateDevelopmentScope({ workspaceId: ws.id, targetPaths: ['.env.local'], allowedPaths: ['.env.local'] }, facts)).toThrow('受保护')
    expect(() => validateDevelopmentScope({ workspaceId: ws.id, targetPaths: ['src/a.ts'], allowedPaths: ['src'], reviewerId: 'agent-x' }, facts)).toThrow('AI 员工')
    expect(validateDevelopmentScope({ workspaceId: ws.id, targetPaths: ['src/a.ts'], allowedPaths: ['src', 'docs'], reviewerId: 'local-user' }, facts)).toMatchObject({ targetPaths: ['src/a.ts'] })
  })
})

describe('任务关联（T02/T03）', () => {
  test('Given 人类负责人任务 Without 确认 When 设置范围 Then 拒绝；显式确认后成功', async () => {
    const project = store.createProject({ title: '范围关联', description: '' })
    const human = store.createTask(project.id, { description: '', title: '人工任务', assignee: { userId: 'local-user', displayName: '用户' } })
    const ws = createAgentWorkspace(`link-${Math.random().toString(36).slice(2, 8)}`, tempRepoDir('link'))
    const facts = { getWorkspace: (id: string) => id === ws.id ? ws : undefined }
    const scope = { workspaceId: ws.id, targetPaths: ['src/a.ts'], allowedPaths: ['src'] }

    expect(() => setTaskDevelopmentScope(human.id, scope, {}, facts)).toThrow('显式确认改派')
    const linked = setTaskDevelopmentScope(human.id, scope, { confirmHumanReassign: true }, facts)
    expect(linked.developmentScope?.workspaceId).toBe(ws.id)

    const other = createAgentWorkspace(`link2-${Math.random().toString(36).slice(2, 8)}`, tempRepoDir('link2'))
    const facts2 = { getWorkspace: (id: string) => id === other.id ? other : undefined }
    expect(() => setTaskDevelopmentScope(human.id, { ...scope, workspaceId: other.id }, { confirmHumanReassign: true }, facts2)).toThrow('换绑')
  })

  test('Given 已完成任务或不存在任务 When 设置范围 Then 拒绝', async () => {
    const project = store.createProject({ title: '范围边界', description: '' })
    const task = store.createTask(project.id, {description: '',  title: '已完成' })
    store.updateTask(task.id, { status: 'completed' })
    const ws = createAgentWorkspace(`done-${Math.random().toString(36).slice(2, 8)}`, tempRepoDir('done'))
    const facts = { getWorkspace: (id: string) => id === ws.id ? ws : undefined }
    expect(() => setTaskDevelopmentScope('not-exist', { workspaceId: ws.id, targetPaths: ['a.ts'], allowedPaths: ['a.ts'] }, {}, facts)).toThrow('任务不存在')
    expect(() => setTaskDevelopmentScope(task.id, { workspaceId: ws.id, targetPaths: ['a.ts'], allowedPaths: ['a.ts'] }, {}, facts)).toThrow('已完成')
  })

  test('Given 任务工作区与范围不一致 When 派发预检 Then 拒绝隐式回退（T03）', async () => {
    const project = store.createProject({ title: '派发预检', description: '' })
    const task = store.createTask(project.id, {description: '',  title: '预检', workspaceId: 'ws-other' })
    const ws = createAgentWorkspace(`dispatch-${Math.random().toString(36).slice(2, 8)}`, tempRepoDir('dispatch'))
    const facts = { getWorkspace: (id: string) => id === ws.id ? ws : undefined }
    store.updateTask(task.id, { developmentScope: { workspaceId: ws.id, targetPaths: ['src/a.ts'], allowedPaths: ['src'] } })
    expect(() => resolveDevelopmentDispatchScope(store.getTask(task.id)!, facts)).toThrow('不一致')
    expect(() => resolveDevelopmentDispatchScope(store.createTask(project.id, {description: '',  title: '无范围' }), facts)).toThrow('研发执行范围')
  })
})
