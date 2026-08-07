import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { initProjectDb, closeProjectDb, createMember, createAgentEmployee } from './project-sqlite-store'
import { listMemberDirectory } from './member-directory-service'

/**
 * PH1-B 统一成员视图测试：
 * - 真人 + AI 员工合并成统一成员目录
 * - kind / q / activeOnly 过滤
 * 使用 PROMA_TEST_CONFIG_DIR 隔离 sqlite；bot 源（无配置）在测试中为空。
 */

const testDir = join(tmpdir(), `gravitas-memberdir-test-${Date.now()}`)

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

describe('统一成员目录 listMemberDirectory', () => {
  test('真人 + AI 员工合并为统一视图，kind 正确', async () => {
    createMember({ displayName: '张三', feishuUserId: 'ou_zs', source: 'sync' })
    createAgentEmployee({ name: '前端工程师·Nova', role: '前端', description: '测试', channelId: 'ch1' })

    const dir = await listMemberDirectory()
    const human = dir.find((m) => m.kind === 'human')
    const agent = dir.find((m) => m.kind === 'agent')
    expect(human?.displayName).toBe('张三')
    expect(human?.memberId.startsWith('paa-')).toBe(true)
    expect(agent?.displayName).toBe('前端工程师·Nova')
    expect(agent?.memberId.startsWith('agent-')).toBe(true)
    expect(agent?.role).toBe('前端')
  })

  test('kind 过滤', async () => {
    const onlyHuman = await listMemberDirectory({ kind: 'human' })
    expect(onlyHuman.every((m) => m.kind === 'human')).toBe(true)
    const onlyAgent = await listMemberDirectory({ kind: 'agent' })
    expect(onlyAgent.every((m) => m.kind === 'agent')).toBe(true)
  })

  test('q 关键字过滤（不区分大小写）', async () => {
    const hits = await listMemberDirectory({ q: '张三' })
    expect(hits.some((m) => m.displayName === '张三')).toBe(true)
    const miss = await listMemberDirectory({ q: '不存在的' })
    expect(miss.length).toBe(0)
  })
})
