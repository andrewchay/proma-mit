/**
 * 记忆治理（P0-2）单测：
 * - 纯函数：textSimilarity / computeRetrievalScore / planConsolidation
 * - 服务层：createMemoryItem 效用先验、归档过滤与排序、runMemoryMaintenance、restore 回滚、recordMemoryUsage 反馈
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { computeRetrievalScore, planConsolidation, textSimilarity } from './memory-governance'
import {
  createMemoryItem,
  getMemoryItem,
  listMemoryItems,
  recordMemoryUsage,
  restoreMemoryItem,
  runMemoryMaintenance,
  searchMemoryItems,
  type MemoryItem,
} from './memory-plugin-service'

const testDir = join(tmpdir(), `gravitas-memory-gov-test-${Date.now()}`)

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
})

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()

function mkItem(overrides: Partial<MemoryItem> & { id: string }): MemoryItem {
  return {
    title: 't',
    content: 'c',
    kind: 'preference',
    tags: [],
    confidence: 0.8,
    sourceRunId: null,
    sourceSessionId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('textSimilarity', () => {
  it('完全相同的文本相似度为 1', () => {
    expect(textSimilarity('用户偏好简洁回复', '用户偏好简洁回复')).toBe(1)
  })

  it('近似表述有高相似度', () => {
    const sim = textSimilarity('用户偏好简洁直接的回复风格', '用户偏好简洁直接的回答风格')
    expect(sim).toBeGreaterThan(0.6)
  })

  it('无关文本相似度低', () => {
    const sim = textSimilarity('用户喜欢喝咖啡', '数据库迁移方案评审')
    expect(sim).toBeLessThan(0.2)
  })
})

describe('computeRetrievalScore', () => {
  it('效用越高分越高', () => {
    const high = computeRetrievalScore(mkItem({ id: 'a', utilityScore: 0.9 }), NOW)
    const low = computeRetrievalScore(mkItem({ id: 'b', utilityScore: 0.2 }), NOW)
    expect(high).toBeGreaterThan(low)
  })

  it('越久未更新分越低（新近度衰减）', () => {
    const fresh = computeRetrievalScore(mkItem({ id: 'a', updatedAt: NOW }), NOW)
    const stale = computeRetrievalScore(mkItem({ id: 'b', updatedAt: NOW - 60 * DAY }), NOW)
    expect(fresh).toBeGreaterThan(stale)
  })

  it('lastUsedAt 优先于 updatedAt 作为新近度基准', () => {
    const used = computeRetrievalScore(mkItem({ id: 'a', updatedAt: NOW - 60 * DAY, lastUsedAt: NOW }), NOW)
    const unused = computeRetrievalScore(mkItem({ id: 'b', updatedAt: NOW - 60 * DAY, lastUsedAt: null }), NOW)
    expect(used).toBeGreaterThan(unused)
  })

  it('无 utilityScore 时回退 confidence', () => {
    const byConfidence = computeRetrievalScore(mkItem({ id: 'a', confidence: 0.9 }), NOW)
    const explicit = computeRetrievalScore(mkItem({ id: 'b', confidence: 0.9, utilityScore: 0.9 }), NOW)
    expect(byConfidence).toBeCloseTo(explicit, 5)
  })
})

describe('planConsolidation', () => {
  it('同 kind 高相似条目合并，幸存者为效用最高者', () => {
    const a = mkItem({ id: 'a', title: '用户偏好简洁回复', content: '回复要简短', utilityScore: 0.9 })
    const b = mkItem({ id: 'b', title: '用户偏好简洁回复', content: '回复要简短', utilityScore: 0.4, tags: ['style'] })
    const plan = planConsolidation([a, b], NOW)
    expect(plan.merges.length).toBe(1)
    expect(plan.merges[0]!.survivorId).toBe('a')
    expect(plan.merges[0]!.archivedIds).toEqual(['b'])
    expect(plan.merges[0]!.mergedTags).toEqual(['style'])
  })

  it('不同 kind 的相似条目不合并', () => {
    const a = mkItem({ id: 'a', kind: 'preference', title: '用户偏好简洁回复', content: '回复要简短' })
    const b = mkItem({ id: 'b', kind: 'fact', title: '用户偏好简洁回复', content: '回复要简短' })
    const plan = planConsolidation([a, b], NOW)
    expect(plan.merges.length).toBe(0)
  })

  it('低效用 + 超期条目进入遗忘归档', () => {
    // 注意：三条内容必须互不相似，否则会被聚类合并而非走遗忘路径
    const stale = mkItem({ id: 'old', title: '过时会议安排', content: '某次临时会议的时间地点', utilityScore: 0.1, updatedAt: NOW - 120 * DAY })
    const fresh = mkItem({ id: 'new', title: '新的备注', content: '刚记录的一条普通备注', utilityScore: 0.1, updatedAt: NOW })
    const highValue = mkItem({ id: 'good', title: '核心偏好', content: '长期重要的工作偏好', utilityScore: 0.9, updatedAt: NOW - 120 * DAY })
    const plan = planConsolidation([stale, fresh, highValue], NOW)
    expect(plan.forgetArchiveIds).toEqual(['old'])
  })

  it('diary 豁免遗忘', () => {
    const diary = mkItem({ id: 'd', kind: 'diary', utilityScore: 0.1, updatedAt: NOW - 365 * DAY })
    const plan = planConsolidation([diary], NOW)
    expect(plan.forgetArchiveIds).toEqual([])
  })

  it('已归档条目不参与计划', () => {
    const a = mkItem({ id: 'a', title: 'x 偏好', content: 'y' })
    const b = mkItem({ id: 'b', title: 'x 偏好', content: 'y', archivedAt: NOW - DAY })
    const plan = planConsolidation([a, b], NOW)
    expect(plan.merges.length).toBe(0)
  })
})

describe('memory-plugin-service 治理集成', () => {
  it('createMemoryItem 以 confidence 初始化效用先验', () => {
    const item = createMemoryItem({
      title: '测试偏好',
      content: '喜欢简洁',
      kind: 'preference',
      tags: [],
      confidence: 0.7,
      sourceRunId: null,
      sourceSessionId: null,
    })
    expect(item.utilityScore).toBe(0.7)
    expect(item.useCount).toBe(0)
    expect(item.archivedAt).toBeNull()
  })

  it('runMemoryMaintenance 合并重复并归档低效用超期条目', () => {
    // 两条高度相似的 preference（合并）
    const keep = createMemoryItem({
      title: '用户沟通风格偏好', content: '用户偏好简洁直接的回复风格，不要客套话',
      kind: 'preference', tags: ['style'], confidence: 0.9, sourceRunId: null, sourceSessionId: null,
    })
    const dup = createMemoryItem({
      title: '用户沟通风格偏好', content: '用户偏好简洁直接的回复风格，不要客套话',
      kind: 'preference', tags: ['comm'], confidence: 0.5, sourceRunId: null, sourceSessionId: null,
    })
    // 一条低效用超期 fact（遗忘）
    const stale = createMemoryItem({
      title: '临时事实', content: '某次临时会议安排',
      kind: 'fact', tags: [], confidence: 0.1, sourceRunId: null, sourceSessionId: null,
    })
    // 手工把它改老（越过 90 天阈值）
    const items = listMemoryItems(undefined, { includeArchived: true })
    const staleRaw = items.find((i) => i.id === stale.id)!
    staleRaw.updatedAt = Date.now() - 120 * DAY
    staleRaw.utilityScore = 0.1
    // 直接通过 maintenance 前的内部状态写回：用 updateMemoryItem 不行（会刷新 updatedAt），改用 restore 通道之外的底层写
    // —— 这里利用 recordMemoryUsage 之外的持久化：直接读改写由 maintenance 前的快照完成。
    // 简化：用 runMemoryMaintenance 的 maxAgeDays=0 + utilityThreshold=0.2 触发遗忘
    const report = runMemoryMaintenance({ maxAgeDays: 0, utilityThreshold: 0.2 })
    expect(report.mergedGroups).toBe(1)
    expect(report.mergedArchivedIds).toContain(dup.id)
    expect(report.forgottenIds).toContain(stale.id)

    // 幸存者聚合了 tags 与最大 confidence
    const survivor = getMemoryItem(keep.id)!
    expect(survivor.mergedFrom).toContain(dup.id)
    expect(survivor.tags.sort()).toEqual(['comm', 'style'])
    expect(survivor.confidence).toBe(0.9)

    // 归档条目默认不出现在列表/搜索
    expect(listMemoryItems().some((i) => i.id === dup.id)).toBe(false)
    expect(searchMemoryItems('沟通风格').some((i) => i.id === dup.id)).toBe(false)
    expect(getMemoryItem(dup.id)!.archivedAt).not.toBeNull()
    expect(getMemoryItem(dup.id)!.mergedInto).toBe(keep.id)
  })

  it('restoreMemoryItem 回滚归档', () => {
    const archived = listMemoryItems(undefined, { includeArchived: true }).find((i) => i.archivedAt)!
    const restored = restoreMemoryItem(archived.id)!
    expect(restored.archivedAt).toBeNull()
    expect(listMemoryItems().some((i) => i.id === archived.id)).toBe(true)
  })

  it('recordMemoryUsage 更新使用信号与效用（EMA）', () => {
    const item = createMemoryItem({
      title: '使用反馈测试', content: '内容',
      kind: 'fact', tags: [], confidence: 0.5, sourceRunId: null, sourceSessionId: null,
    })
    const updated = recordMemoryUsage(item.id, 1.0)!
    expect(updated.useCount).toBe(1)
    expect(updated.lastUsedAt).not.toBeNull()
    // EMA: 0.5*0.7 + 1.0*0.3 = 0.65
    expect(updated.utilityScore).toBeCloseTo(0.65, 5)
  })

  it('listMemoryItems 按 效用×新近度 降序', () => {
    const listed = listMemoryItems()
    for (let i = 0; i < listed.length - 1; i++) {
      const sa = computeRetrievalScore(listed[i]!, Date.now())
      const sb = computeRetrievalScore(listed[i + 1]!, Date.now())
      expect(sa).toBeGreaterThanOrEqual(sb)
    }
  })
})
