/**
 * 任务乐观锁测试 — Task Optimistic Lock Test
 *
 * 人 + agent 并发写收敛点：调用方传入 expectedUpdatedAt 时，
 * 任务若已被他人先写则拒绝（后写者需刷新重试），防止静默覆盖。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import {
  closeProjectDb,
  createProject,
  createTask,
  initProjectDb,
} from './project-sqlite-store'
import { getTask, updateTask } from './project-service'

const testDir = join(tmpdir(), `gravitas-optimistic-lock-${Date.now()}`)

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  await initProjectDb()
})

afterAll(() => {
  closeProjectDb()
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
  delete process.env.PROMA_TEST_CONFIG_DIR
})

describe('任务乐观锁（人 + agent 并发写）', () => {
  test('Given 基于旧版本 When 他人已先写 Then 拒绝并提示刷新', async () => {
    const project = createProject({ title: '锁项目', description: '' })
    const task = createTask(project.id, { title: '并发任务', description: '' })
    const staleVersion = task.updatedAt

    // 他人先写（agent 先挪了状态）
    await new Promise((resolve) => setTimeout(resolve, 5))
    await updateTask(task.id, { status: 'in_progress' })
    const afterOther = await getTask(task.id)
    expect(afterOther!.updatedAt).not.toBe(staleVersion)

    // 人基于旧版本写 → 冲突
    await expect(updateTask(task.id, { title: '人的修改' }, { expectedUpdatedAt: staleVersion }))
      .rejects.toThrow(/已被其他操作更新/)
  })

  test('Given 基于最新版本 When 写入 Then 正常生效', async () => {
    const project = createProject({ title: '锁项目二', description: '' })
    const task = createTask(project.id, { title: '正常写入', description: '' })
    const current = await getTask(task.id)
    const updated = await updateTask(task.id, { priority: 'high' }, { expectedUpdatedAt: current!.updatedAt })
    expect(updated?.priority).toBe('high')
  })

  test('Given 未传版本号 When 写入 Then 不启用锁（兼容既有调用方）', async () => {
    const project = createProject({ title: '锁项目三', description: '' })
    const task = createTask(project.id, { title: '兼容路径', description: '' })
    await updateTask(task.id, { status: 'in_progress' })
    // 旧调用方（不传 expectedUpdatedAt）行为不变
    const updated = await updateTask(task.id, { title: '直接覆盖' })
    expect(updated?.title).toBe('直接覆盖')
  })
})
