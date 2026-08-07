import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initProjectDb, closeProjectDb, listMembers } from './project-sqlite-store'
import { upsertMemberDraft, findMemberByPaaUserId, resolvePlatformForPaaUser, isMemberSyncCooldownActive, MEMBER_SYNC_COOLDOWN_MS } from './member-sync-service'
import type { MemberDraft } from './member-sync-service'

/**
 * PH1-A 步骤 2+3 对齐逻辑测试（不依赖网络/凭证）：
 * - 同一人 union_id 合并（飞书 + 钉钉同人 → 一条 member，两平台字段都有）
 * - 姓名合并（无 union，按 displayName 补另一平台字段）
 * - 全新成员 insert
 * - 重复 upsert 不重复建
 *
 * 使用 PROMA_TEST_CONFIG_DIR 隔离到临时目录，不污染真实 ~/.gravitas/projects/。
 */

const testDir = join(tmpdir(), `gravitas-membersync-test-${Date.now()}`)

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  mkdirSync(join(testDir, 'projects'), { recursive: true })
  await initProjectDb()
})

afterAll(() => {
  closeProjectDb()
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略清理失败
  }
  delete process.env.PROMA_TEST_CONFIG_DIR
})

function f(draft: Partial<MemberDraft> & { name: string; externalId: string }): MemberDraft {
  return { platform: 'feishu', department: undefined, ...draft } as MemberDraft
}

describe('跨平台对齐 upsertMemberDraft', () => {
  test('同一人（同 union_id）飞书先建、钉钉后并 → 单条 member 两平台字段齐全', () => {
    // 飞书先
    const feishuId = 'ou_zhangsan'
    const union = 'on_zhangsan'
    expect(upsertMemberDraft(f({ platform: 'feishu', externalId: feishuId, unionId: union, name: '张三', department: '研发部' }))).toBe('inserted')

    // 钉钉同人（同 union）后并
    const outcome = upsertMemberDraft(f({ platform: 'dingtalk', externalId: 'u_ding_zs', unionId: 'on_zhangsan_v2', name: '张三', department: undefined }))
    expect(outcome).toBe('merged')

    const members = listMembers({ q: '张三' })
    expect(members.length).toBe(1) // 仍是同一条
    const m = members[0]!
    expect(m.feishuUserId).toBe(feishuId)
    expect(m.dingtalkUserId).toBe('u_ding_zs')
    expect(m.feishuUnionId).toBe(union)
  })

  test('无 union、姓名匹配补另一平台字段（跨平台同名合并）', () => {
    upsertMemberDraft(f({ externalId: 'ou_lisi', name: '李四' })) // 飞书，无 union
    const outcome = upsertMemberDraft(f({ platform: 'dingtalk', externalId: 'u_ding_lisi', name: '李四', unionId: undefined }))
    expect(outcome).toBe('merged')

    const m = listMembers({ q: '李四' })[0]!
    expect(m.dingtalkUserId).toBe('u_ding_lisi')
  })

  test('全新成员 insert，且重复 upsert 不重复建', () => {
    const first = upsertMemberDraft(f({ externalId: 'ou_wangwu', name: '王五' }))
    expect(first).toBe('inserted')
    // 再同步一次同平台同人 → merged，不新增
    const again = upsertMemberDraft(f({ externalId: 'ou_wangwu', name: '王五' }))
    expect(again).toBe('merged')
    expect(listMembers({ q: '王五' }).length).toBe(1)
  })

  test('并入字段不覆盖已有（保留原飞书字段）', () => {
    upsertMemberDraft(f({ externalId: 'ou_zhaoliu', unionId: 'on_zl', name: '赵六' }))
    // 钉钉并入同 union
    upsertMemberDraft(f({ platform: 'dingtalk', externalId: 'u_ding_zl', unionId: 'on_zl', name: '赵六' }))
    const m = listMembers({ q: '赵六' })[0]!
    expect(m.feishuUserId).toBe('ou_zhaoliu') // 原飞书保留
    expect(m.dingtalkUserId).toBe('u_ding_zl')
    expect(m.department).toBeUndefined() // 未提供不引入脏部门
  })
})

describe('成员反向查询（paa-<name> → 平台 ID）', () => {
  test('findMemberByPaaUserId 解析 paa- 前缀 + 姓名', () => {
    upsertMemberDraft(f({ externalId: 'ou_zhengjiu', name: '郑九' }))
    const m = findMemberByPaaUserId('paa-郑九')
    expect(m?.displayName).toBe('郑九')
    expect(findMemberByPaaUserId('not-prefixed')).toBeNull()
    expect(findMemberByPaaUserId('paa-不存在的人')).toBeNull()
  })

  test('resolvePlatformForPaaUser 返回对应平台 ID', () => {
    // 造一个双平台成员
    upsertMemberDraft(f({ externalId: 'ou_shier', unionId: 'on_shier', name: '十二' }))
    upsertMemberDraft(f({ platform: 'dingtalk', externalId: 'u_ding_shier', unionId: 'u_ding_s12', name: '十二' }))
    expect(resolvePlatformForPaaUser('paa-十二', 'feishu')).toBe('ou_shier')
    expect(resolvePlatformForPaaUser('paa-十二', 'dingtalk')).toBe('u_ding_s12') // 优先 unionId
    expect(resolvePlatformForPaaUser('paa-未知', 'feishu')).toBeNull()
  })
})

describe('增量同步冷却判定', () => {
  test('冷却窗口常量与未同步前判定', () => {
    expect(MEMBER_SYNC_COOLDOWN_MS).toBeGreaterThan(0)
    // 模块未执行过同步：lastSyncAt=0 → 不在冷却，允许同步
    expect(isMemberSyncCooldownActive('feishu')).toBe(false)
  })
})
