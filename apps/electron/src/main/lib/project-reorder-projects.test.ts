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
import { closeProjectDb, initProjectDb, listProjects } from './project-sqlite-store'
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
  test('Given 三个已建项目 When 按新顺序拖拽 Then listProjects 按新顺序返回', async () => {
    const a = await createProject({ title: '甲', description: '' })
    const b = await createProject({ title: '乙', description: '' })
    const c = await createProject({ title: '丙', description: '' })

    const ok = await reorderProjects([c.id, a.id, b.id])
    expect(ok).toBe(true)
    expect((await listProjects()).map((p) => p.id)).toEqual([c.id, a.id, b.id])
  })

  test('Given 已手动排序 When 再次拖拽 Then 顺序以最新一次为准', async () => {
    const [first = '', second = '', third = ''] = (await listProjects()).map((p) => p.id)
    if (!first || !second || !third) return
    const ok = await reorderProjects([second, third, first])
    expect(ok).toBe(true)
    expect((await listProjects()).map((p) => p.id)).toEqual([second, third, first])
  })

  test('Given 排序 When 重写 Then updated_at 不被修改', async () => {
    const before = await listProjects()
    await reorderProjects([...before].reverse().map((p) => p.id))
    const after = await listProjects()
    for (const project of after) {
      const prev = before.find((p) => p.id === project.id)!
      expect(project.updatedAt).toBe(prev.updatedAt)
    }
  })

  test('Given 入参缺失某个项目 When 排序 Then 拒绝且顺序不变', async () => {
    const before = await listProjects()
    const ok = await reorderProjects(before.slice(1).map((p) => p.id))
    expect(ok).toBe(false)
    expect((await listProjects()).map((p) => p.id)).toEqual(before.map((p) => p.id))
  })

  test('Given 入参包含不存在的 id When 排序 Then 拒绝且顺序不变', async () => {
    const before = await listProjects()
    const ok = await reorderProjects([...before.map((p) => p.id), 'not-exist'])
    expect(ok).toBe(false)
    expect((await listProjects()).map((p) => p.id)).toEqual(before.map((p) => p.id))
  })
})
