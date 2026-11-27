/**
 * 达人触达记录服务测试。
 *
 * 覆盖：创建 / 查询 / 状态流转 / 统计 / 删除。
 * 用独立临时配置目录隔离，不污染真实 ~/.gravitas。
 */

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildElectronMock } from '../testing/electron-mock'

const TEST_DIR = join(tmpdir(), `gravitas-outreach-test-${Date.now()}`)
const originalConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const originalMarketingConfigDir = process.env._MAPRO_TEST_CONFIG_DIR

mock.module('electron', () => buildElectronMock())

type OutreachServiceModule = typeof import('./outreach-service')

let service: OutreachServiceModule
let campaignManager: { closeCampaignDatabase: () => void }

describe('达人触达记录服务', () => {
  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true })
    process.env._MAPRO_TEST_CONFIG_DIR = TEST_DIR
    process.env.PROMA_TEST_CONFIG_DIR = TEST_DIR

    campaignManager = await import('../campaign-manager')
    service = await import('./outreach-service')
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

  it('创建记录后可按 id 读回', () => {
    const created = service.createOutreachRecord({
      kolId: 'kol-1',
      kolName: '测试达人',
      channel: 'copy',
      content: '你好，想邀请你合作',
    })

    expect(created.id).toBeTruthy()
    expect(created.kolName).toBe('测试达人')
    expect(created.status).toBe('pending')
    // pending 不写 sentAt
    expect(created.sentAt).toBeNull()

    const fetched = service.getOutreachRecord(created.id)
    expect(fetched?.id).toBe(created.id)
  })

  it('直接以 sent 状态创建时自动补 sentAt', () => {
    const created = service.createOutreachRecord({
      kolName: '已发送达人',
      channel: 'wechat',
      content: '话术',
      status: 'sent',
    })
    expect(created.sentAt).toBeTruthy()
  })

  it('状态流转：pending → replied 时补 sentAt 与 repliedAt', () => {
    const created = service.createOutreachRecord({
      kolName: '流转达人',
      channel: 'copy',
      content: '话术',
    })
    expect(created.sentAt).toBeNull()
    expect(created.repliedAt).toBeNull()

    const replied = service.updateOutreachRecord({ id: created.id, status: 'replied' })
    expect(replied.status).toBe('replied')
    expect(replied.sentAt).toBeTruthy()
    expect(replied.repliedAt).toBeTruthy()
  })

  it('repliedAt 只写一次，重复更新不覆盖', async () => {
    const created = service.createOutreachRecord({
      kolName: '重复更新达人',
      channel: 'copy',
      content: '话术',
    })
    const first = service.updateOutreachRecord({ id: created.id, status: 'replied' })
    const firstRepliedAt = first.repliedAt

    // 等 2ms 确保时间戳不同（Date.now 精度）
    await new Promise((r) => setTimeout(r, 2))
    const second = service.updateOutreachRecord({ id: created.id, status: 'replied' })
    expect(second.repliedAt).toBe(firstRepliedAt)
  })

  it('可按 kolId / status / channel 过滤', () => {
    service.createOutreachRecord({
      kolId: 'filter-kol',
      kolName: '过滤达人',
      channel: 'pgy',
      content: '话术',
      status: 'sent',
    })

    const byKol = service.listOutreachRecords({ kolId: 'filter-kol' })
    expect(byKol.length).toBe(1)
    expect(byKol[0]?.channel).toBe('pgy')

    const byStatus = service.listOutreachRecords({ status: 'sent' })
    expect(byStatus.every((r) => r.status === 'sent')).toBe(true)

    const byChannel = service.listOutreachRecords({ channel: 'pgy' })
    expect(byChannel.every((r) => r.channel === 'pgy')).toBe(true)
  })

  it('统计：总数、状态分布、回复率', () => {
    const before = service.getOutreachStats()
    service.createOutreachRecord({ kolName: '统计A', channel: 'copy', content: 'x', status: 'sent' })
    service.createOutreachRecord({ kolName: '统计B', channel: 'copy', content: 'x', status: 'replied' })
    service.createOutreachRecord({ kolName: '统计C', channel: 'copy', content: 'x', status: 'rejected' })

    const after = service.getOutreachStats()
    expect(after.total).toBe(before.total + 3)
    // 已发送总量 = sent + replied + rejected + converted
    const sentTotal = after.byStatus.sent + after.byStatus.replied + after.byStatus.rejected + after.byStatus.converted
    // 回复率 = (replied + converted) / sentTotal
    expect(after.replyRate).toBeCloseTo((after.byStatus.replied + after.byStatus.converted) / sentTotal, 5)
  })

  it('删除记录后查不到', () => {
    const created = service.createOutreachRecord({
      kolName: '待删除达人',
      channel: 'copy',
      content: '话术',
    })
    service.deleteOutreachRecord(created.id)
    expect(service.getOutreachRecord(created.id)).toBeNull()
  })

  it('更新不存在的记录抛错', () => {
    expect(() => service.updateOutreachRecord({ id: 'not-exist', status: 'sent' })).toThrow(
      /触达记录不存在/,
    )
  })
})
