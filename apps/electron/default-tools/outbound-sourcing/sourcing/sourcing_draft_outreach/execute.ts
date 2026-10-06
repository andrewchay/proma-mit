/**
 * sourcing_draft_outreach — 首封外联草稿简报
 *
 * 增强（对齐 mtxMailAgent composeGojiOutreach / profileOutreach 的画像思路）：
 * - 接收决策人画像字段（职位、痛点、切入角度），生成个性化结构；
 * - 注入领域包 knowledge/redvia.md 品牌知识库摘要，替代硬编码产品话术；
 * - 只生成草稿内容与合规约束，不发送邮件。
 */

const CALENDLY_URL = 'https://calendly.com/0xjackzhy/30min'

interface Input {
  company?: string
  country?: string
  contact_name?: string
  decision_maker_role?: string
  pain_points?: string[]
  product?: string
  angle?: string
  language?: string
}

/** 解析领域包 knowledge 目录（兼容 CJS require 与 ESM import） */
function resolveKnowledgeDir(): string {
  try {
    const base = typeof __dirname !== 'undefined' ? __dirname : ''
    if (base) return join(base, '..', '..', 'knowledge')
  } catch {
    /* 走 ESM 回退 */
  }
  try {
    const { fileURLToPath } = require('node:url') as typeof import('node:url')
    return join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'knowledge')
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
  const company = String(v.company ?? '').trim()
  const product = String(v.product ?? '').trim()
  const angle = String(v.angle ?? '').trim()
  if (!company || !product || !angle) return { content: '参数缺失：company、product、angle', isError: true }

  const contactName = String(v.contact_name ?? '').trim()
  const role = String(v.decision_maker_role ?? '').trim()
  const painPoints = (Array.isArray(v.pain_points) ? v.pain_points : []).map(String).map((s) => s.trim()).filter(Boolean)
  const greeting = contactName ? `Hi ${contactName},` : 'Hello,'
  const subject = `Exploring ${product} supply for ${company}`

  return {
    content: JSON.stringify(
      {
        subject,
        greeting,
        // 画像个性化要素：草稿正文必须围绕 angle 与 pain_points 展开，禁止套模板空话
        persona: {
          decisionMakerRole: role || null,
          painPoints,
          angle,
          guidance: [
            role ? `开头点明对 ${role} 角度相关的业务关切` : '开头点明对采购/供应链负责人的业务关切',
            ...(painPoints.length ? [`正文逐条回应痛点：${painPoints.join('；')}`] : ['正文围绕 angle 说明价值主张']),
            '结尾以低压力方式询问当前采购需求与偏好下一步',
          ],
        },
        // 品牌知识库：撰写时引用相关事实，知识库没有的信息用提问澄清，不编造
        knowledge: loadKnowledge(resolveKnowledgeDir()) || null,
        language: v.language ?? 'en',
        country: v.country ?? '',
        signOff: ['Best regards,', 'Jack', 'Redvia / RedVia-BRY International Co.'],
        safety: [
          '发送前由人工核验收件人、事实、价格与合规表述',
          `未明确表达推进意向前不附 Calendly（${CALENDLY_URL}），冷首触一律不带`,
          '该工具不发送邮件，也不把候选公司当成已验证事实',
        ],
      },
      null,
      2,
    ),
  }
}
