/**
 * reorderProjects 测试 — 项目列表手动拖拽排序
 *
 * 行为约定：
 * - 按入参 id 顺序整体重写 sort_order，listProjects 依此返回；
 * - 排序不动 updated_at（排序不是内容更新）；
 * - 入参与库内项目集合不一致（缺失/多余）时整体拒绝，顺序保持不变。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { closeProjectDb, createTask, getProjectDb, initProjectDb, listProjects, updateProject as updateProjectRecord, deleteProject as deleteProjectRecord } from './project-sqlite-store'
import { createProject, reorderProjects } from './project-service'

const testDir = join(tmpdir(), `gravitas-reorder-projects-${Date.now()}`)

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  await initProjectDb()
})

afterAll(() => {
  closeProjectDb()
  delete process.env.PROMA_TEST_CONFIG_DIR
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响测试 */
  }
})

describe('reorderProjects', () => {
  test('Given Owner证据阻止物理删除的项目 When 归档并恢复 Then 项目和任务证据都保留', async () => {
    const project = await createProject({ title: '需保留证据的项目', description: '' })
    const task = createTask(project.id, { title: 'Owner承载任务', description: '' })
    getProjectDb().prepare('INSERT INTO project_owner_planning_links (id, project_id, request_id, planning_task_id, input_hash, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run('owner-link', project.id, 'request-1', task.id, 'input-hash', '{}')

    expect(() => deleteProjectRecord(project.id)).toThrow('Owner规划准备或Run证据')
    for (const archivedAt of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => updateProjectRecord(project.id, { archivedAt })).toThrow('项目归档时间')
    }
    expect(listProjects(false).some(item => item.id === project.id)).toBe(true)
    const archived = updateProjectRecord(project.id, { archivedAt: Date.now() })
    expect(archived?.archivedAt).toBeGreaterThan(0)
    expect(listProjects(false).some(item => item.id === project.id)).toBe(false)
    expect(listProjects(true).some(item => item.id === project.id)).toBe(true)
    expect(listProjects().some(item => item.id === project.id)).toBe(true)

    const restored = updateProjectRecord(project.id, { archivedAt: null })
    expect(restored?.archivedAt).toBeUndefined()
    expect(listProjects(false).some(item => item.id === project.id)).toBe(true)
    expect(getProjectDb().prepare('SELECT id FROM tasks WHERE id = ?').get(task.id)).toEqual({ id: task.id })
    expect(getProjectDb().prepare('SELECT id FROM project_owner_planning_links WHERE id = ?').get('owner-link')).toEqual({ id: 'owner-link' })
    updateProjectRecord(project.id, { archivedAt: Date.now() })
  })

  test('Given 三个已建项目 When 按新顺序拖拽 Then listProjects 按新顺序返回', async () => {
    const a = await createProject({ title: '甲', description: '' })
    const b = await createProject({ title: '乙', description: '' })
    const c = await createProject({ title: '丙', description: '' })

    const ok = await reorderProjects([c.id, a.id, b.id])
    expect(ok).toBe(true)
    expect((await listProjects(false)).map((p) => p.id)).toEqual([c.id, a.id, b.id])
  })

  test('Given 已手动排序 When 再次拖拽 Then 顺序以最新一次为准', async () => {
    const [first = '', second = '', third = ''] = (await listProjects(false)).map((p) => p.id)
    if (!first || !second || !third) return
    const ok = await reorderProjects([second, third, first])
    expect(ok).toBe(true)
    expect((await listProjects(false)).map((p) => p.id)).toEqual([second, third, first])
  })

  test('Given 排序 When 重写 Then updated_at 不被修改', async () => {
    const before = await listProjects(false)
    await reorderProjects([...before].reverse().map((p) => p.id))
    const after = await listProjects(false)
    for (const project of after) {
      const prev = before.find((p) => p.id === project.id)!
      expect(project.updatedAt).toBe(prev.updatedAt)
    }
  })

  test('Given 入参缺失某个项目 When 排序 Then 拒绝且顺序不变', async () => {
    const before = await listProjects(false)
    const ok = await reorderProjects(before.slice(1).map((p) => p.id))
    expect(ok).toBe(false)
    expect((await listProjects(false)).map((p) => p.id)).toEqual(before.map((p) => p.id))
  })

  test('Given 入参包含不存在的 id When 排序 Then 拒绝且顺序不变', async () => {
    const before = await listProjects(false)
    const ok = await reorderProjects([...before.map((p) => p.id), 'not-exist'])
    expect(ok).toBe(false)
    expect((await listProjects(false)).map((p) => p.id)).toEqual(before.map((p) => p.id))
  })
})
