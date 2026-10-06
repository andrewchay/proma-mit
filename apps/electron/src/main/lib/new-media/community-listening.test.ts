import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'; import { join } from 'node:path'; import { tmpdir } from 'node:os'
import { closeNewMediaDb } from './new-media-sqlite-store'
import { createListeningQuery, createReplyDraft, getListeningDigest, ingestEngagement, ingestMention, resetCommunityListeningForTests } from './community-listening'
let testDir = ''
beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-new-media-community-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { await resetCommunityListeningForTests() })
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })
describe('新媒体互动与社交聆听', () => {
  test('投诉互动升级人工而不生成自动回复草稿', async () => { const item = await ingestEngagement({ platform: 'xiaohongshu', channel: 'comment', author: '用户A', text: '产品有问题，我要投诉退款' }); expect(item.intent).toBe('complaint'); expect(item.priority).toBe('urgent'); expect(item.requiresHumanReview).toBe(true); await expect(createReplyDraft(item.id)).rejects.toThrow('需要人工处理') })
  test('普通咨询可生成仅供审核的回复草稿', async () => { const item = await ingestEngagement({ platform: 'xiaohongshu', channel: 'comment', author: '用户B', text: '这个产品怎么使用？' }); const reply = await createReplyDraft(item.id); expect(reply.status).toBe('draft'); expect(reply.text).toContain('核实') })
  test('监听摘要聚合高风险负面提及并可重启读取', async () => { const query = await createListeningQuery(['品牌A']); await ingestMention({ queryId: query.id, platform: 'xiaohongshu', sourceUrl: 'https://example.com/post', text: '品牌A涉嫌欺骗消费者，建议维权' }); closeNewMediaDb(); const digest = await getListeningDigest(query.id); expect(digest.total).toBe(1); expect(digest.sentiment.negative).toBe(1); expect(digest.highRiskMentions).toHaveLength(1) })
})
