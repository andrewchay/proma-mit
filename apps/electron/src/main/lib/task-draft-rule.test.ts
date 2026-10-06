/**
 * 草稿组进出规则测试 — Task Draft Rule Test
 *
 * draft 是流程外待确认态：只能经 confirmTaskDraft/rejectTaskDraft 离开，
 * 普通状态更新不得进出 draft 组（防止绕过确认闭环）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import {
  closeProjectDb,
  confirmTaskDraft,
  createProject,
  createTask,
  createTaskDraft,
  initProjectDb,
  updateTask,
} from './project-sqlite-store'

const testDir = join(tmpdir(), `gravitas-draft-rule-${Date.now()}`)

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

describe('draft 组进出规则', () => {
  test('Given 普通任务 When 状态改回 draft Then 拒绝并提示', () => {
    const project = createProject({ title: '草稿规则项目', description: '' })
    const task = createTask(project.id, { title: '普通任务', description: '' })
    expect(() => updateTask(task.id, { status: 'draft' })).toThrow(/不能通过状态编辑改回草稿/)
  })

  test('Given 草稿任务 When 通过 updateTask 直接改状态 Then 拒绝并引导走确认链路', () => {
    const project = createProject({ title: '草稿规则项目二', description: '' })
    const draft = createTaskDraft(project.id, { title: '草稿任务', description: '' })
    expect(() => updateTask(draft.id, { status: 'in_progress' })).toThrow(/「确认」或「拒绝」/)
  })

  test('Given 草稿任务 When confirmTaskDraft Then 正常落入 pending（唯一合法出口）', () => {
    const project = createProject({ title: '草稿规则项目三', description: '' })
    const draft = createTaskDraft(project.id, { title: '待确认', description: '' })
    const confirmed = confirmTaskDraft(draft.id)
    expect(confirmed?.status).toBe('pending')
  })

  test('Given 普通任务 When draft 组内互转不存在（只有单一 draft 态）Then updateTask 同组改写不受限', () => {
    const project = createProject({ title: '草稿规则项目四', description: '' })
    const task = createTask(project.id, { title: '普通任务二', description: '' })
    // 同值写回（statusChanged=false）不触发规则
    const updated = updateTask(task.id, { status: 'pending' })
    expect(updated?.status).toBe('pending')
  })
})
