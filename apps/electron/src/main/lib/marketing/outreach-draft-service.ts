/**
 * 达人回复草稿生成。
 *
 * 定位：**只生成草稿，不发送**。用户看到草稿后自己决定改不改、发不发。
 *
 * 为什么不自动发：微信自动化走坐标点击 + OCR，失败模式是「静默点错位置」，
 * 发错人不可撤回。成本远高于用户点一下复制。
 *
 * 话术来源：ma-kol-outreach（达人建联话术库）定义品牌侧固定信息与分级契约；
 * 这里不复述话术全文，只把「对话上下文 + 风险分级要求」交给 LLM。
 */

import type { WechatMessage } from './wechat-readonly-service'
import { completePrompt } from './ma-tools/llm-service'

/** 草稿生成结果 */
export interface OutreachDraft {
  /** 建议回复正文（可直接复制发送） */
  reply: string
  /** 对话所处阶段，如「破冰」「报价」「档期」 */
  stage: string
  /** 风险等级：low 可放心发；high 涉及报价/返点/合同，需人工确认 */
  risk: 'low' | 'high'
  /** 给人工看的说明：为什么这样回、哪里需要自己补 */
  note: string
}

export interface GenerateDraftInput {
  /** 达人备注名 */
  contact: string
  /** 最近对话（时间正序）。优先传历史库里的完整对话，OCR 结果只作补充 */
  messages: WechatMessage[]
  /** 品牌侧固定信息（由 readBrandContext + formatBrandContext 生成） */
  brandContext?: string
  /** 更早对话的结构化摘要（来自 buildConversationContext，长对话不丢关键信息） */
  earlierSummary?: string
}

/** 草稿生成固定使用的模型（低推理强度，快且省） */
const DRAFT_MODEL_ID = 'glm-5.3'

const SYSTEM_PROMPT = `你是一位资深达人营销 PR，负责小红书上达人合作的日常沟通。

任务：根据对话上下文，起草一条可以**直接发给达人**的回复。

输出严格 JSON：
{
  "stage": "当前阶段，如：破冰/自我介绍/邀约/索要报价/报价沟通/档期/寄样/合同/催稿/其他",
  "risk": "low 或 high",
  "reply": "可以直接发出的回复正文",
  "note": "给内部同事看的说明：这条回复的意图、需要人工补充的信息"
}

风险分级规则：
- risk=low：破冰、自我介绍、品牌介绍、邀约、索要报价表、确认收到、闲聊承接。
- risk=high：涉及**具体报价数字、返点比例、档期承诺、寄样地址、合同条款、打款**。
  这些一旦发错损失不可逆，必须让人工确认。

写作要求：
1. 像真人聊天，不要客服腔，不要「亲」「宝子」这类电商话术。
2. 简短。微信里没人读长段落，通常 1-3 句。
3. 不要编造品牌信息、价格、档期。信息不足时，用【待补充：xxx】标出来。
4. 不要重复达人刚说过的话。
5. 一条回复只推进一件事，不要一次问三个问题。`

/** 把对话转成可读文本 */
function formatTranscript(messages: WechatMessage[]): string {
  if (messages.length === 0) return '（暂无历史消息）'
  return messages
    .map((m) => `${m.dir === 'out' ? '我方' : '达人'}：${m.text}`)
    .join('\n')
}

/**
 * 生成回复草稿。
 *
 * 失败时抛出可读错误，由 IPC 层转成用户提示。
 *
 * brandContext 由调用方传入（主进程从工作区 ma-kol-outreach 解析）。
 * 不在这里直接读工作区，是为了让服务保持无状态、可测。
 */
export async function generateOutreachDraft(input: GenerateDraftInput): Promise<OutreachDraft> {
  if (input.messages.length === 0) {
    throw new Error('对话为空，无法生成草稿')
  }

  const userPrompt = [
    `达人备注名：${input.contact}`,
    input.brandContext ? `\n品牌侧信息：\n${input.brandContext}` : '',
    input.earlierSummary ? `\n更早的对话摘要：\n${input.earlierSummary}` : '',
    `\n最近对话（时间正序）：\n${formatTranscript(input.messages)}`,
    '\n请起草下一条回复。',
  ]
    .filter(Boolean)
    .join('\n')

  const result = await completePrompt(userPrompt, SYSTEM_PROMPT, {
    temperature: 0.7,
    modelId: DRAFT_MODEL_ID,
    // 写 1-3 句微信话术用低推理强度即可：
    // GLM-5.3 默认是 max，对这句话术任务是浪费（更慢更贵）。
    effort: 'low',
  })
  if (!result.success) {
    throw new Error(`生成草稿失败：${result.error ?? '未知错误'}`)
  }

  const parsed = extractJson(result.text)
  if (!parsed) {
    // 模型没按 JSON 返回时，退化为「整段当回复」，避免整条链路失败
    return {
      reply: result.text.trim(),
      stage: '未知',
      risk: 'high',
      note: '模型未按结构化格式返回，已把原文作为草稿。请人工确认后再发送。',
    }
  }

  const risk = String(parsed.risk ?? 'high').toLowerCase() === 'low' ? 'low' : 'high'
  return {
    reply: String(parsed.reply ?? '').trim(),
    stage: String(parsed.stage ?? '未知'),
    risk,
    note: String(parsed.note ?? ''),
  }
}

/** 从模型输出里抠出第一个 JSON 对象 */
function extractJson(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
