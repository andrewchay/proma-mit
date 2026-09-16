import { randomUUID } from 'node:crypto'
import type { NewMediaPlatform } from './content-operations'
import { clearNewMediaRecordsForTests, getNewMediaRecord, listNewMediaRecords, putNewMediaRecord } from './new-media-sqlite-store'

export type EngagementChannel = 'comment' | 'direct-message'
export type EngagementIntent = 'praise' | 'question' | 'complaint' | 'cooperation' | 'spam' | 'other'
export type EngagementPriority = 'low' | 'normal' | 'high' | 'urgent'
export type Sentiment = 'positive' | 'neutral' | 'negative'
export interface EngagementItem { id: string; platform: NewMediaPlatform; channel: EngagementChannel; author: string; text: string; intent: EngagementIntent; sentiment: Sentiment; priority: EngagementPriority; requiresHumanReview: boolean; createdAt: number }
export interface ReplyDraft { id: string; engagementId: string; text: string; status: 'draft'; createdAt: number }
export interface ListeningQuery { id: string; keywords: string[]; createdAt: number }
export interface Mention { id: string; queryId: string; platform: NewMediaPlatform; sourceUrl: string; text: string; sentiment: Sentiment; risk: 'none' | 'watch' | 'high'; createdAt: number }

const ENGAGEMENT_KIND = 'engagement'
const REPLY_KIND = 'reply-draft'
const QUERY_KIND = 'listening-query'
const MENTION_KIND = 'mention'

function includesAny(text: string, values: string[]): boolean { return values.some((value) => text.includes(value)) }
function classify(text: string): Pick<EngagementItem, 'intent' | 'sentiment' | 'priority' | 'requiresHumanReview'> {
  const compact = text.trim().toLowerCase()
  if (includesAny(compact, ['退款', '投诉', '欺骗', '骗子', '曝光', '维权', '垃圾', '违法'])) return { intent: 'complaint', sentiment: 'negative', priority: 'urgent', requiresHumanReview: true }
  if (includesAny(compact, ['合作', '商务', '报价', '联名'])) return { intent: 'cooperation', sentiment: 'neutral', priority: 'high', requiresHumanReview: true }
  if (includesAny(compact, ['加微信', '私聊', '兼职', '点击链接', '博彩'])) return { intent: 'spam', sentiment: 'negative', priority: 'low', requiresHumanReview: false }
  if (includesAny(compact, ['怎么', '如何', '吗', '？', '?', '哪里买', '价格'])) return { intent: 'question', sentiment: 'neutral', priority: 'normal', requiresHumanReview: false }
  if (includesAny(compact, ['喜欢', '好看', '支持', '谢谢', '种草'])) return { intent: 'praise', sentiment: 'positive', priority: 'low', requiresHumanReview: false }
  return { intent: 'other', sentiment: 'neutral', priority: 'normal', requiresHumanReview: false }
}

export async function ingestEngagement(input: Pick<EngagementItem, 'platform' | 'channel' | 'author' | 'text'>): Promise<EngagementItem> {
  if (!input.author.trim() || !input.text.trim()) throw new Error('互动作者和内容不能为空')
  return putNewMediaRecord(ENGAGEMENT_KIND, { id: randomUUID(), ...input, ...classify(input.text), createdAt: Date.now() })
}
export async function listEngagements(priority?: EngagementPriority): Promise<EngagementItem[]> {
  const items = await listNewMediaRecords<EngagementItem>(ENGAGEMENT_KIND)
  return items.filter((item) => !priority || item.priority === priority).sort((a, b) => b.createdAt - a.createdAt)
}
export async function createReplyDraft(engagementId: string): Promise<ReplyDraft> {
  const item = await getNewMediaRecord<EngagementItem>(ENGAGEMENT_KIND, engagementId)
  if (!item) throw new Error('互动不存在')
  if (item.requiresHumanReview) throw new Error('该互动需要人工处理，不能生成自动回复草稿')
  const textByIntent: Record<Exclude<EngagementIntent, 'complaint' | 'cooperation'>, string> = {
    praise: '感谢你的支持和喜欢！我们会继续分享真实、有用的内容。',
    question: '感谢关注。为避免给出不准确的信息，请告诉我们你想了解的具体产品或使用场景，我们会尽快核实回复。',
    spam: '此内容不适合回复，建议按平台规则处理。', other: '感谢留言。我们已收到你的反馈，会认真参考。',
  }
  return putNewMediaRecord(REPLY_KIND, { id: randomUUID(), engagementId, text: textByIntent[item.intent as Exclude<EngagementIntent, 'complaint' | 'cooperation'>], status: 'draft', createdAt: Date.now() })
}
export async function listReplyDrafts(): Promise<ReplyDraft[]> { return listNewMediaRecords(REPLY_KIND) }
export async function createListeningQuery(keywords: string[]): Promise<ListeningQuery> {
  const normalized = [...new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean))]
  if (normalized.length === 0) throw new Error('至少提供一个监控关键词')
  return putNewMediaRecord(QUERY_KIND, { id: randomUUID(), keywords: normalized, createdAt: Date.now() })
}
export async function listListeningQueries(): Promise<ListeningQuery[]> { return listNewMediaRecords(QUERY_KIND) }
export async function ingestMention(input: Omit<Mention, 'id' | 'sentiment' | 'risk' | 'createdAt'>): Promise<Mention> {
  if (!await getNewMediaRecord<ListeningQuery>(QUERY_KIND, input.queryId)) throw new Error('监听任务不存在')
  if (!input.text.trim() || !input.sourceUrl.trim()) throw new Error('提及内容和来源链接不能为空')
  const compact = input.text.toLowerCase()
  const negative = includesAny(compact, ['投诉', '欺骗', '骗子', '曝光', '翻车', '退款', '垃圾'])
  const highRisk = includesAny(compact, ['违法', '维权', '曝光', '欺骗', '骗子'])
  return putNewMediaRecord(MENTION_KIND, { id: randomUUID(), ...input, sentiment: negative ? 'negative' : 'neutral', risk: highRisk ? 'high' : negative ? 'watch' : 'none', createdAt: Date.now() })
}
export async function listMentions(queryId?: string): Promise<Mention[]> {
  const values = await listNewMediaRecords<Mention>(MENTION_KIND)
  return values.filter((mention) => !queryId || mention.queryId === queryId)
}
export async function getListeningDigest(queryId: string): Promise<{ query: ListeningQuery; total: number; sentiment: Record<Sentiment, number>; highRiskMentions: Mention[] }> {
  const query = await getNewMediaRecord<ListeningQuery>(QUERY_KIND, queryId)
  if (!query) throw new Error('监听任务不存在')
  const matched = await listMentions(queryId)
  const sentiment: Record<Sentiment, number> = { positive: 0, neutral: 0, negative: 0 }
  for (const mention of matched) sentiment[mention.sentiment] += 1
  return { query, total: matched.length, sentiment, highRiskMentions: matched.filter((mention) => mention.risk === 'high') }
}
export async function resetCommunityListeningForTests(): Promise<void> { await clearNewMediaRecordsForTests() }
