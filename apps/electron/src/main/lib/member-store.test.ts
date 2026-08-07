import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initProjectDb, closeProjectDb } from './project-sqlite-store'
import {
  createMember,
  getMember,
  findMember,
  updateMember,
  listMembers,
  deleteMember,
  saveUserMapping,
  getUserMapping,
  listUserMappings,
} from './project-sqlite-store'

/**
 * PH1-A 数据层测试：
 * - members 表 CRUD（稳定成员档案）
 * - user_mappings 升级：feishu_union_id 列 + 写入/读取兼容
 *
 * 使用 PROMA_TEST_CONFIG_DIR 把 projects DB（sql.js 内存库 + 落盘）隔离到临时目录，
 * 不污染开发机真实 ~/.gravitas/projects/paa.db。
 */

const testDir = join(tmpdir(), `gravitas-member-store-test-${Date.now()}`)

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

describe('members 表（稳定成员档案）', () => {
  test('createMember 落档并生成稳定 memberId + plain_name', () => {
    const m = createMember({
      displayName: '张三',
      feishuUserId: 'ou_x',
      feishuUnionId: 'on_union_x',
      dingtalkUserId: 'u_ding',
      dingtalkUnionId: 'u_ding_union',
      department: '研发部',
    })
    expect(m.memberId).toBeTruthy()
    expect(m.kind).toBe('human')
    expect(m.plainName).toBe('张三') // 中文不转换，但 trim+lowercase
    expect(m.feishuUserId).toBe('ou_x')
    expect(m.source).toBe('sync')
    expect(m.active).toBe(true)

    const again = getMember(m.memberId)
    expect(again?.displayName).toBe('张三')
  })

  test('findMember 按 union_id / 平台 id / 姓名 都能命中', () => {
    const m = createMember({ displayName: '李四', feishuUnionId: 'on_lisi' })
    expect(findMember({ feishuUnionId: 'on_lisi' })?.memberId).toBe(m.memberId)
    expect(findMember({ displayName: '李四' })?.memberId).toBe(m.memberId)
    expect(findMember({ feishuUnionId: 'none' })).toBeNull()
  })

  test('updateMember 合并平台字段，未提供字段保留原值', () => {
    const m = createMember({ displayName: '王五', feishuUnionId: 'on_wangwu' })
    const updated = updateMember(m.memberId, { dingtalkUserId: 'u_wangwu' })
    expect(updated?.dingtalkUserId).toBe('u_wangwu')
    expect(updated?.feishuUnionId).toBe('on_wangwu') // 原飞书保留
    expect(updated?.displayName).toBe('王五')
    expect(getMember(m.memberId)?.feishuUnionId).toBe('on_wangwu')
  })

  test('updateMember 支持停用 active=false', () => {
    const m = createMember({ displayName: '赵六' })
    const updated = updateMember(m.memberId, { active: false })
    expect(updated?.active).toBe(false)
  })

  test('listMembers 支持 kind / activeOnly / q 过滤', () => {
    const a = createMember({ displayName: 'active-a', feishuUnionId: 'on_a' })
    createMember({ displayName: 'inactive-b', feishuUnionId: 'on_b' })
    updateMember(a.memberId, { active: false })

    expect(listMembers({ activeOnly: true }).every((m) => m.active)).toBe(true)
    expect(listMembers({ q: 'active-a' }).length).toBe(1)
    expect(listMembers({ kind: 'agent' }).every((m) => m.kind === 'agent')).toBe(true)
  })

  test('deleteMember 物理删除', () => {
    const m = createMember({ displayName: 'to-delete' })
    expect(deleteMember(m.memberId)).toBe(true)
    expect(getMember(m.memberId)).toBeNull()
  })
})

describe('user_mappings 升级（feishu_union_id）', () => {
  test('saveUserMapping 支持 feishuUnionId 与兼容旧字段', () => {
    const mapping = saveUserMapping({
      paaUserId: 'paa-张三',
      displayName: '张三',
      feishuUserId: 'ou_x',
      feishuUnionId: 'on_union_x',
      dingtalkUserId: 'u_ding',
    })
    expect(mapping.feishuUnionId).toBe('on_union_x')
    expect(mapping.dingtalkUserId).toBe('u_ding')
  })

  test('getUserMapping / listUserMappings 读回 feishuUnionId', () => {
    const got = getUserMapping('paa-张三')
    expect(got?.feishuUnionId).toBe('on_union_x')
    const all = listUserMappings()
    const target = all.find((u) => u.paaUserId === 'paa-张三')
    expect(target?.feishuUnionId).toBe('on_union_x')
  })

  test('重复 save 同一 paaUserId 时合并字段、不丢另一平台', () => {
    saveUserMapping({ paaUserId: 'paa-李四', displayName: '李四', feishuUnionId: 'on_lisi' })
    saveUserMapping({ paaUserId: 'paa-李四', displayName: '李四', dingtalkUserId: 'u_lisi' })
    const got = getUserMapping('paa-李四')
    expect(got?.feishuUnionId).toBe('on_lisi') // 保留飞书
    expect(got?.dingtalkUserId).toBe('u_lisi') // 新增钉钉
  })
})
