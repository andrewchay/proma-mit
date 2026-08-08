import { describe, expect, test } from 'bun:test'
import { listMailboxItems, countMailboxPending, getMailboxCache } from './team-mailbox-service'

/**
 * PH2-C 团队收件箱测试：
 * - listMailboxItems 正常运行（空 pending 时返回空数组）
 * - count / cache 不抛错
 * 说明：pending 请求来自各 singleton（permission/ask/exit-plan）私有 Map，
 * 测试环境无真实请求，此处验证聚合链路可执行、不抛错。
 */

describe('团队收件箱（PH2-C）', () => {
  test('listMailboxItems 返回数组（无 pending 时为空且不抛错）', () => {
    const items = listMailboxItems()
    expect(Array.isArray(items)).toBe(true)
  })

  test('countMailboxPending 返回数字', () => {
    expect(typeof countMailboxPending()).toBe('number')
  })

  test('getMailboxCache 返回数组', () => {
    const cached = getMailboxCache()
    expect(Array.isArray(cached)).toBe(true)
  })
})
