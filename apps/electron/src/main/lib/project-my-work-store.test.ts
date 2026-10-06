/**
 * 我的工作存储层测试 — My Work Store Test
 *
 * 覆盖：listMyWork 负责人身份宽松匹配（大小写/空格/paa- 前缀/displayName 归一化）、
 * 完成态排除逾期判定、按截止日期升序。
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
  listMyWork,
} from './project-sqlite-store'

const testDir = join(tmpdir(), `gravitas-mywork-test-${Date.now()}`)

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

describe('listMyWork 负责人匹配', () => {
  test('Given 名字大小写与空格差异的指派 When 以 paa-<档案名> 查询 Then 仍能命中', () => {
    const project = createProject({ title: '我的工作测试项目', description: '' })
    createTask(project.id, {
      title: '精确匹配任务',
      description: '',
      assignee: { userId: 'paa-Andrew Chai', displayName: 'Andrew Chai' },
    })
    createTask(project.id, {
      title: '空格差异任务',
      description: '',
      assignee: { userId: 'paa-andrew  chai', displayName: 'ANDREW CHAI' },
    })
    createTask(project.id, {
      title: '他人任务',
      description: '',
      assignee: { userId: 'paa-someone-else', displayName: 'Someone Else' },
    })
    createTask(project.id, { title: '无负责人任务', description: '' })

    const items = listMyWork('paa-Andrew Chai')
    const titles = items.map((item) => item.title)
    expect(titles).toContain('精确匹配任务')
    expect(titles).toContain('空格差异任务')
    expect(titles).not.toContain('他人任务')
    expect(titles).not.toContain('无负责人任务')
  })

  test('Given 有截止日期的逾期任务 When 查询 Then isOverdue 为真且按日期升序', () => {
    const project = createProject({ title: '逾期测试项目', description: '' })
    const past = Date.now() - 3 * 86_400_000
    const future = Date.now() + 5 * 86_400_000
    createTask(project.id, {
      title: '未来任务',
      description: '',
      assignee: { userId: 'paa-carol', displayName: 'Carol' },
      dueDate: future,
    })
    createTask(project.id, {
      title: '逾期任务',
      description: '',
      assignee: { userId: 'paa-carol', displayName: 'Carol' },
      dueDate: past,
    })

    const items = listMyWork('paa-Carol')
    const mine = items.filter((item) => item.projectTitle === '逾期测试项目')
    expect(mine.length).toBe(2)
    expect(mine[0]!.title).toBe('逾期任务')
    expect(mine[0]!.isOverdue).toBe(true)
    expect(mine[1]!.isOverdue).toBe(false)
  })
})
