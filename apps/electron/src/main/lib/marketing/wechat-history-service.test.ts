/**
 * 微信对话历史存储测试。
 *
 * 重点验证去重：同一条消息重复读取不应产生重复行，
 * 否则「未回复数」会随读取次数虚增。
 */

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildElectronMock } from '../testing/electron-mock'

const TEST_DIR = join(tmpdir(), `gravitas-wechat-history-test-${Date.now()}`)
const originalConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const originalMarketingConfigDir = process.env._MAPRO_TEST_CONFIG_DIR

mock.module('electron', () => buildElectronMock())

type HistoryModule = typeof import('./wechat-history-service')
type Msg = import('./wechat-readonly-service').WechatMessage

let history: HistoryModule
let campaignManager: { closeCampaignDatabase: () => void }

const msg = (dir: 'in' | 'out', text: string, y = 0): Msg => ({ dir, text, y })

describe('微信对话历史', () => {
  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true })
    process.env._MAPRO_TEST_CONFIG_DIR = TEST_DIR
    process.env.PROMA_TEST_CONFIG_DIR = TEST_DIR
    campaignManager = await import('../campaign-manager')
    history = await import('./wechat-history-service')
  })

  afterAll(() => {
    campaignManager.closeCampaignDatabase()
    for (const name of ['campaign-database.sqlite', 'kol-database.sqlite']) {
      const p = join(TEST_DIR, name)
      if (existsSync(p)) rmSync(p, { force: true })
    }
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
    if (originalMarketingConfigDir === undefined) delete process.env._MAPRO_TEST_CONFIG_DIR
    else process.env._MAPRO_TEST_CONFIG_DIR = originalMarketingConfigDir
    if (originalConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
    else process.env.PROMA_TEST_CONFIG_DIR = originalConfigDir
  })

  it('首次同步全部插入', () => {
    const inserted = history.syncConversation('达人A', [
      msg('out', '你好'),
      msg('in', '在的'),
    ])
    expect(inserted).toBe(2)
    expect(history.getConversationHistory('达人A')).toHaveLength(2)
  })

  it('重复同步同一批消息 → 不产生重复行（去重核心）', () => {
    history.syncConversation('达人B', [msg('in', '第一条'), msg('in', '第二条')])
    const second = history.syncConversation('达人B', [msg('in', '第一条'), msg('in', '第二条')])
    expect(second).toBe(0)
    expect(history.getConversationHistory('达人B')).toHaveLength(2)
  })

  it('方向不同的相同文字视为两条（达人复述我方原话）', () => {
    history.syncConversation('达人C', [msg('out', '好的')])
    history.syncConversation('达人C', [msg('in', '好的')])
    const list = history.getConversationHistory('达人C')
    expect(list).toHaveLength(2)
    expect(list.map((m) => m.direction).sort()).toEqual(['in', 'out'])
  })

  it('增量同步：旧消息不重复，新消息追加', () => {
    history.syncConversation('达人D', [msg('in', '一'), msg('in', '二')])
    const inserted = history.syncConversation('达人D', [
      msg('in', '一'),
      msg('in', '二'),
      msg('in', '三'),
    ])
    expect(inserted).toBe(1)
    expect(history.getConversationHistory('达人D')).toHaveLength(3)
  })

  it('历史按时间正序返回', () => {
    history.syncConversation('达人E', [msg('in', 'A'), msg('in', 'B'), msg('in', 'C')])
    const list = history.getConversationHistory('达人E')
    expect(list.map((m) => m.content)).toEqual(['A', 'B', 'C'])
  })

  it('我方消息天然标记 replied，达人消息初始未回复', () => {
    history.syncConversation('达人F', [msg('out', '我方'), msg('in', '达人')])
    const list = history.getConversationHistory('达人F')
    expect(list.find((m) => m.direction === 'out')?.replied).toBe(true)
    expect(list.find((m) => m.direction === 'in')?.replied).toBe(false)
  })

  it('未回复数统计正确', () => {
    history.syncConversation('达人G', [msg('in', '待回1'), msg('in', '待回2')])
    const conv = history.listConversations().find((c) => c.contact === '达人G')
    expect(conv?.pendingCount).toBe(2)
  })

  it('标记已回复后未回复数归零', () => {
    history.syncConversation('达人H', [msg('in', '待回')])
    expect(history.listConversations().find((c) => c.contact === '达人H')?.pendingCount).toBe(1)

    const updated = history.markConversationReplied('达人H')
    expect(updated).toBe(1)
    expect(history.listConversations().find((c) => c.contact === '达人H')?.pendingCount).toBe(0)
  })

  it('重复标记不重复计数', () => {
    history.syncConversation('达人I', [msg('in', '待回')])
    history.markConversationReplied('达人I')
    expect(history.markConversationReplied('达人I')).toBe(0)
  })

  it('清空某达人历史不影响其他达人', () => {
    history.syncConversation('达人J', [msg('in', 'J 的消息')])
    history.syncConversation('达人K', [msg('in', 'K 的消息')])

    history.clearConversation('达人J')
    expect(history.getConversationHistory('达人J')).toHaveLength(0)
    expect(history.getConversationHistory('达人K')).toHaveLength(1)
  })

  it('空文本消息被跳过', () => {
    const inserted = history.syncConversation('达人L', [msg('in', '  '), msg('in', '有效')])
    expect(inserted).toBe(1)
  })

  // ===== 上下文装配（长对话不丢关键信息）=====

  describe('buildConversationContext', () => {
    it('短对话：全部保留，无摘要', () => {
      history.syncConversation('短对话', [msg('in', '你好'), msg('out', '在的')])
      const ctx = history.buildConversationContext('短对话')
      expect(ctx.recent).toHaveLength(2)
      expect(ctx.summary).toBe('')
      expect(ctx.foldedCount).toBe(0)
    })

    it('超长对话：按字符预算截断，更早的折叠', () => {
      // 每条约 100 字符，30 条约 3000 字符
      const long = Array.from({ length: 30 }, (_, i) =>
        msg(i % 2 === 0 ? 'in' : 'out', `第${i}条消息${'啊'.repeat(90)}`),
      )
      history.syncConversation('长对话', long)

      const ctx = history.buildConversationContext('长对话', { charBudget: 500 })
      // 预算 500 装不下 30 条，必然折叠
      expect(ctx.foldedCount).toBeGreaterThan(0)
      expect(ctx.summary).toContain('更早还有')
      // 最近的消息必须在（不能把最新一条折掉）
      expect(ctx.recent[ctx.recent.length - 1]?.content).toContain('第29条')
    })

    it('摘要能抽出报价与返点（关键事实不丢）', () => {
      const messages = [
        msg('in', '我们这边报价5000返30可以吗'),
        ...Array.from({ length: 25 }, (_, i) => msg('out', `寒暄${i}${'嗯'.repeat(50)}`)),
      ]
      history.syncConversation('报价对话', messages)

      const ctx = history.buildConversationContext('报价对话', { charBudget: 300 })
      expect(ctx.foldedCount).toBeGreaterThan(0)
      // 早期的报价信息应被摘要保留
      expect(ctx.summary).toMatch(/报过价|返点/)
    })

    it('摘要能抽出档期信息', () => {
      const messages = [
        msg('in', '档期的话我下周三可以拍'),
        ...Array.from({ length: 25 }, (_, i) => msg('out', `闲聊${i}${'哦'.repeat(50)}`)),
      ]
      history.syncConversation('档期对话', messages)

      const ctx = history.buildConversationContext('档期对话', { charBudget: 300 })
      expect(ctx.summary).toMatch(/档期/)
    })

    it('无关键事实时摘要给兜底说明，不编造', () => {
      const messages = Array.from({ length: 30 }, (_, i) =>
        msg('out', `你好呀${i}${'呢'.repeat(60)}`),
      )
      history.syncConversation('寒暄对话', messages)

      const ctx = history.buildConversationContext('寒暄对话', { charBudget: 300 })
      expect(ctx.summary).toContain('无明确报价/档期信息')
    })

    it('空对话返回空上下文', () => {
      const ctx = history.buildConversationContext('不存在的达人')
      expect(ctx.recent).toHaveLength(0)
      expect(ctx.summary).toBe('')
      expect(ctx.totalMessages).toBe(0)
    })

    it('totalMessages 反映真实总数，不受 recentLimit 影响', () => {
      const messages = Array.from({ length: 60 }, (_, i) => msg('in', `消息${i}`))
      history.syncConversation('大量消息', messages)

      const ctx = history.buildConversationContext('大量消息', { recentLimit: 10, charBudget: 99999 })
      expect(ctx.totalMessages).toBe(60)
      expect(ctx.recent).toHaveLength(10)
      expect(ctx.foldedCount).toBe(50)
    })

    it('默认预算 100k：300 条常规对话全部保留（不触发折叠）', () => {
      // 每条约 40 字，300 条 ≈ 12000 字，远低于 100k 预算
      const messages = Array.from({ length: 300 }, (_, i) =>
        msg(i % 2 === 0 ? 'in' : 'out', `第${i}条：这是一条典型的达人沟通消息，长度约四十个字左右哦`),
      )
      history.syncConversation('常规长对话', messages)

      const ctx = history.buildConversationContext('常规长对话')
      expect(ctx.recent).toHaveLength(300)
      expect(ctx.foldedCount).toBe(0)
      expect(ctx.summary).toBe('')
    })

    it('默认 recentLimit=300 生效：超过 300 条时按条数截断', () => {
      const messages = Array.from({ length: 400 }, (_, i) => msg('in', `消息${i}`))
      history.syncConversation('超量对话', messages)

      const ctx = history.buildConversationContext('超量对话')
      expect(ctx.recent).toHaveLength(300)
      expect(ctx.foldedCount).toBe(100)
      // 最新一条必须在
      expect(ctx.recent[ctx.recent.length - 1]?.content).toBe('消息399')
    })

    it('自定义预算可覆盖默认值', () => {
      const messages = Array.from({ length: 50 }, (_, i) => msg('in', `消息${i}${'啊'.repeat(80)}`))
      history.syncConversation('自定义预算', messages)

      const tight = history.buildConversationContext('自定义预算', { charBudget: 500 })
      const loose = history.buildConversationContext('自定义预算', { charBudget: 100_000 })
      expect(tight.recent.length).toBeLessThan(loose.recent.length)
      expect(loose.foldedCount).toBe(0)
    })
  })
})
