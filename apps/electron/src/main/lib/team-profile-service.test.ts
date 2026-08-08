import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { getTeamProfile, updateTeamProfile, buildTeamProfileContext } from './team-profile-service'

/**
 * PH2-A 团队档案测试：
 * - 空默认
 * - 更新与读回
 * - buildTeamProfileContext 生成注入文本
 * 使用 PROMA_TEST_CONFIG_DIR 隔离。
 */

const testDir = join(tmpdir(), `gravitas-teamprofile-test-${Date.now()}`)

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
  delete process.env.PROMA_TEST_CONFIG_DIR
})

describe('团队档案（PH2-A）', () => {
  test('未设置返回默认空档案', () => {
    const p = getTeamProfile('ws-x')
    expect(p.teamName).toBe('')
    expect(p.updatedAt).toBe(0)
  })

  test('update 后读回，浅合并保留其他字段', () => {
    updateTeamProfile('ws-x', { teamName: '前端组', focusAreas: '性能优化' })
    const p = getTeamProfile('ws-x')
    expect(p.teamName).toBe('前端组')
    expect(p.focusAreas).toBe('性能优化')
    expect(p.preferences).toBe('')
    // 再更新只改一项，其他保留
    updateTeamProfile('ws-x', { preferences: '结果中文' })
    const p2 = getTeamProfile('ws-x')
    expect(p2.teamName).toBe('前端组')
    expect(p2.preferences).toBe('结果中文')
  })

  test('buildTeamProfileContext 生成注入文本', () => {
    updateTeamProfile('ws-x', { teamName: '前端组', membersSummary: '张三(前端) 李四(测试)', preferences: '结果中文' })
    const ctx = buildTeamProfileContext('ws-x')
    expect(ctx).toContain('前端组')
    expect(ctx).toContain('张三(前端)')
    expect(ctx).toContain('结果中文')
    expect(buildTeamProfileContext('ws-empty')).toBe('')
  })

  test('超长字段被截断（防撑爆上下文）', () => {
    const big = 'a'.repeat(10_000)
    updateTeamProfile('ws-big', { preferences: big })
    const p = getTeamProfile('ws-big')
    // 单个字段上限 FIELD_CHAR_LIMIT=4000
    expect(p.preferences!.length).toBe(4000)
    // 整体上下文也有限额，可安全生成而不膨胀
    const ctx = buildTeamProfileContext('ws-big')
    expect(ctx.length).toBeLessThan(13000)
  })
})
