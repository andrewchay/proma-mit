import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listNewMediaAudit } from './new-media-audit'
import {
  BUILT_IN_COMPLIANCE_RULES,
  COMPLIANCE_DISCLAIMER,
  reviewAndEscalateNewMediaContent,
  scanNewMediaContent,
} from './new-media-compliance-guard'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from './new-media-sqlite-store'

let testDir = ''
beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-compliance-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { await clearNewMediaRecordsForTests() })
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

const PLATFORM = 'wechat-official-account' as const

describe('P4-08 合规规则库', () => {
  test('四类规则齐备，每条都有独立的建议与免责声明', () => {
    const categories = new Set(BUILT_IN_COMPLIANCE_RULES.map((rule) => rule.category))
    expect([...categories].sort()).toEqual(['advertising-law', 'copyright', 'crisis', 'platform-rule'])
    expect(BUILT_IN_COMPLIANCE_RULES.every((rule) => rule.suggestion.length > 5)).toBe(true)
    expect(BUILT_IN_COMPLIANCE_RULES.every((rule) => rule.message.length > 5)).toBe(true)
    expect(COMPLIANCE_DISCLAIMER).toContain('不构成法律意见')
  })

  test('高危规则只给修改建议并升级人工，不阻断', () => {
    const review = scanNewMediaContent({ platform: PLATFORM, content: '全网最低价，用了立刻见效，效果第一！' })
    expect(review.findings.length).toBeGreaterThan(0)
    expect(review.requiresHumanReview).toBe(true)
    // 守卫没有「阻断」概念：结果只有发现与建议
    expect(review.findings.every((finding) => ['suggest', 'high-risk'].includes(finding.severity))).toBe(true)
    expect(review.disclaimer).toContain('不构成法律意见')
  })

  test('广告法绝对化用语被识别并给出可执行建议', () => {
    const review = scanNewMediaContent({ platform: PLATFORM, title: '最好用的面霜', content: '纯正文，没有风险词。' })
    const finding = review.findings.find((item) => item.ruleId === 'adlaw-superlative')
    expect(finding).toBeDefined()
    expect(finding?.matchedText).toBe('最好')
    expect(finding?.suggestion).toContain('改为可验证')
    expect(review.requiresHumanReview).toBe(true)
  })

  test('平台导流词与仿冒词被识别', () => {
    const review = scanNewMediaContent({ platform: PLATFORM, content: '需要的加微信私聊购买，A货原单都有' })
    const ruleIds = review.findings.map((finding) => finding.ruleId)
    expect(ruleIds).toContain('platform-offsite')
    expect(ruleIds).toContain('platform-counterfeit')
  })

  test('危机信号升级人工', () => {
    const review = scanNewMediaContent({ platform: PLATFORM, content: '再不退款我就工商投诉、315 见' })
    expect(review.requiresHumanReview).toBe(true)
    expect(review.findings.some((finding) => finding.category === 'crisis')).toBe(true)
  })

  test('版权提示为建议级，不升级', () => {
    const review = scanNewMediaContent({ platform: PLATFORM, content: '配图为网图侵删，产品是大牌同款平替。' })
    expect(review.findings.map((finding) => finding.ruleId)).toContain('copyright-source')
    expect(review.findings.map((finding) => finding.ruleId)).toContain('copyright-brand')
    expect(review.requiresHumanReview).toBe(false)
  })

  test('干净内容零发现，且仍然声明不构成法律意见', () => {
    const review = scanNewMediaContent({ platform: PLATFORM, title: '秋日穿搭记录', content: '今天去了公园，拍了三组照片。' })
    expect(review.findings).toEqual([])
    expect(review.requiresHumanReview).toBe(false)
    expect(review.disclaimer).toContain('不构成法律意见')
  })

  test('同一命中只报一次，大小写不敏感', () => {
    const review = scanNewMediaContent({ platform: PLATFORM, content: '这是全网最低 全网最低 全网最低' })
    const superlative = review.findings.filter((finding) => finding.ruleId === 'adlaw-superlative')
    expect(superlative).toHaveLength(1)
  })

  test('升级人工写入审计，记录命中词与建议但不含凭据', async () => {
    const review = await reviewAndEscalateNewMediaContent({
      platform: PLATFORM,
      content: '最好的产品，加微信购买',
      subjectId: 'action-1',
      accountId: 'acc-1',
      actor: 'Carol',
    })
    expect(review.requiresHumanReview).toBe(true)
    const audits = await listNewMediaAudit()
    const compliance = audits.filter((entry) => entry.domain === 'compliance')
    expect(compliance).toHaveLength(1)
    expect(compliance[0]?.event).toBe('escalated')
    expect(compliance[0]?.detail).toContain('升级人工复核')
    expect(compliance[0]?.detail).toContain('广告法绝对化用语')
  })

  test('低风险内容记录 review_completed', async () => {
    await reviewAndEscalateNewMediaContent({
      platform: PLATFORM,
      content: '今天天气不错。',
      subjectId: 'action-2',
      accountId: 'acc-1',
      actor: 'Carol',
    })
    const audits = await listNewMediaAudit()
    expect(audits.filter((entry) => entry.domain === 'compliance').at(-1)?.event).toBe('review_completed')
  })
})
