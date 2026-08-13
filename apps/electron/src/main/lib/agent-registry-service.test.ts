import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { buildAgentCardFromEmployee } from '@gravitas/shared'
import { listAgentCards, getAgentCard } from './agent-registry-service'
import { closeProjectDb, createAgentEmployee, initProjectDb } from './project-sqlite-store'

const testDir = join(tmpdir(), `gravitas-agent-registry-test-${Date.now()}`)

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

describe('agent-registry-service', () => {
  it('将全部 AI 员工档案暴露为 Agent Cards', () => {
    const name = `员工-${randomUUID().slice(0, 8)}`
    createAgentEmployee({ name, role: '测试岗', description: '', channelId: 'ch-test', skills: ['docx'] })

    const cards = listAgentCards()
    const mine = cards.find((c) => c.name === name)
    expect(mine).toBeDefined()
    expect(mine?.source).toBe('employee')
    expect(mine?.capabilities).toContain('docx')
    expect(mine?.role).toBe('测试岗')
  })

  it('getAgentCard 按 cardId 读取单个员工卡片', () => {
    const name = `员工单卡-${randomUUID().slice(0, 8)}`
    const emp = createAgentEmployee({ name, role: '单卡岗', description: '', channelId: 'ch-test' })

    const card = getAgentCard(emp.id)
    expect(card).not.toBeNull()
    expect(card?.employeeId).toBe(emp.id)
    expect(card?.name).toBe(name)
  })

  it('getAgentCard 对不存在的 cardId 返回 null', () => {
    expect(getAgentCard('no-such-card-id')).toBeNull()
  })

  it('buildAgentCardFromEmployee 可作为纯函数独立使用', () => {
    const card = buildAgentCardFromEmployee({
      id: 'pure-1', name: '纯函数', role: 'r', description: '',
      skills: [], enabled: true, totalTasks: 0, completedTasks: 0, failureCount: 0,
      createdAt: 1, updatedAt: 1,
    })
    expect(card.cardId).toBe('pure-1')
    expect(card.source).toBe('employee')
  })
})
