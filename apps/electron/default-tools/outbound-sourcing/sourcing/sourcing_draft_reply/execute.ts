/**
 * sourcing_draft_reply — 回复草稿简报（移植自 redvia-mail-composer/reply_composer.py）
 *
 * 设计约束（与领域包一致）：
 * - 本工具只产出"回复草稿简报"（人设 prompt、回复规则、线程头、Calendly 意向判定），
 *   由 Agent 依据简报撰写草稿正文；不调用 LLM API，不发送任何邮件。
 * - Calendly 规则与 REPLY_RULES 双重约束：低意向来信绝不允许附带 Calendly 链接。
 */

/** 与 reply_composer.py 的 DEFAULT_BASE_PROMPT 一致 */
const BASE_PROMPT =
  'You are Jack, the Head of Sales at Redvia. Write concise, polite, ' +
  'commercially aware email replies on behalf of Redvia and sign off as ' +
  'Jack when appropriate.'

/** 与 reply_composer.py 的 REPLY_RULES 原样一致 */
const REPLY_RULES = [
  'Rules:',
  '- Keep the tone professional and friendly.',
  '- Keep the response concise.',
  '- If information is missing, ask 1-2 clarifying questions.',
  '- Only share the Calendly link when the client clearly shows interest in moving forward (meeting, next steps, call, pricing discussion, samples, partnership, or purchase intent). Never include it in cold, generic, or low-intent replies.',
  '- Return plain text only.',
].join('\n')

const CALENDLY_URL = 'https://calendly.com/0xjackzhy/30min'

/** 高意向信号（与 REPLY_RULES 的 Calendly 触发条件对应） */
const HIGH_INTENT_PATTERNS: Array<[RegExp, string]> = [
  [/meeting|call|schedule|appointment|zoom|teams/i, '提出会议/通话请求'],
  [/next step/i, '询问下一步'],
  [/price|pricing|quote|quotation|cif|fob|moq/i, '询问价格/报价/MOQ'],
  [/sample|specification|spec sheet|catalog/i, '索要样品/规格/目录'],
  [/partnership|distribut|agency|resell|cooperation|purchase|order|buy/i, '表达合作/采购意向'],
]

interface Input {
  from_email?: string
  from_name?: string
  subject?: string
  body?: string
  message_id?: string
  references?: string[]
  language?: string
}

/** 解析 knowledge 目录：兼容 CJS require（主进程）与 ESM import（bun test） */
function resolveKnowledgeDir(): string {
  try {
    // execute.ts 经 require() 加载时 __dirname 指向工具目录的上一级？不——
    // 工具目录为 <plugin>/sourcing/sourcing_draft_reply，knowledge 在 <plugin>/knowledge
    const base = typeof __dirname !== 'undefined' ? __dirname : ''
    if (base) return join(base, '..', '..', 'knowledge')
  } catch {
    /* CJS 上下文不可用时走 ESM 回退 */
  }
  try {
    const { fileURLToPath } = require('node:url') as typeof import('node:url')
    const here = fileURLToPath(new URL('.', import.meta.url))
    return join(here, '..', '..', 'knowledge')
  } catch {
    return ''
  }
}

function loadKnowledge(dir: string): string {
  if (!dir) return ''
  try {
    const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return ''
    const supported = ['.md', '.txt', '.json', '.yml', '.yaml']
    const parts: string[] = []
    for (const name of readdirSync(dir).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
      const file = join(dir, name)
      if (!statSync(file).isFile()) continue
      if (!supported.some((ext) => name.toLowerCase().endsWith(ext))) continue
      const content = readFileSync(file, 'utf-8').trim()
      if (content) parts.push(`File: ${name}\n${content}`)
    }
    return parts.join('\n\n')
  } catch {
    return ''
  }
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/')
}

export async function execute(input: unknown): Promise<{ content: string; isError?: boolean }> {
  const v = (input ?? {}) as Input
  const fromEmail = String(v.from_email ?? '').trim()
  const subject = String(v.subject ?? '').trim()
  const body = String(v.body ?? '').trim()
  if (!fromEmail || !subject || !body) {
    return { content: '参数缺失：from_email、subject、body 至少各填写一项', isError: true }
  }

  // Calendly 意向判定：高意向才允许在回复中给出链接
  const matchedIntents = HIGH_INTENT_PATTERNS.filter(([re]) => re.test(body)).map(([, label]) => label)
  const calendlyAllowed = matchedIntents.length > 0

  // 线程头（与 reply_composer.py build_reply_headers 一致）
  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`
  const messageId = String(v.message_id ?? '').trim()
  const references = (Array.isArray(v.references) ? v.references : []).map(String).filter(Boolean)
  if (messageId) references.push(messageId)

  const knowledge = loadKnowledge(resolveKnowledgeDir())
  const systemPrompt = knowledge
    ? [BASE_PROMPT, 'Use the following business context when it is relevant to the email.', knowledge].join('\n\n')
    : BASE_PROMPT

  return {
    content: JSON.stringify(
      {
        to: fromEmail,
        fromName: v.from_name?.trim() || fromEmail,
        replySubject,
        threadHeaders: { inReplyTo: messageId || null, references },
        systemPrompt,
        replyRules: REPLY_RULES,
        calendlyPolicy: calendlyAllowed
          ? { allowed: true, url: CALENDLY_URL, matchedIntents, note: '来信含高意向信号，可在回复中自然给出 Calendly 链接' }
          : { allowed: false, url: null, matchedIntents: [], note: '低意向/冷回复，禁止包含 Calendly 链接' },
        language: v.language ?? 'en',
        safety: [
          '草稿撰写完成后逐条核对 REPLY_RULES；纯文本输出',
          '该工具只生成草稿与线程头，不发送邮件；发送前由人工核验收件人、事实与合规表述',
          '不得在草稿中编造价格、认证、产能或物流承诺；知识库没有的事实用提问澄清',
        ],
      },
      null,
      2,
    ),
  }
}
