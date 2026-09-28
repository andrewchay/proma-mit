import { createHash } from 'node:crypto'
import type { PilotRequestEnvelope } from './project-pilot-request-envelope'

/**
 * 逐请求费用证据绑定：价格必须来自版本库中的审核记录，请求身份必须是最终 HTTP 请求体的
 * SHA-256 指纹。生产价格注册表默认为空——没有入库的审核记录时，任何请求都不得生成包络、
 * 预留或发送（fail-closed）。
 */

export type PilotProviderKind = 'openai' | 'anthropic' | 'google'

export interface PilotReviewedPriceEvidence {
  /** 稳定 ID；包络与子预留通过它引用本记录。 */
  evidenceId: string
  providerKind: PilotProviderKind
  /** 精确模型名；请求体中出现的 model 必须与之一致。 */
  model: string
  /** 已审核价格包络，micro-USD / 百万 token，须覆盖缓存与推理价格。 */
  inputMicrosPerMillion: number
  outputMicrosPerMillion: number
  /** 无法按 token 归类的最高附加费用，micro-USD。 */
  extraCostCeilingMicros: number
  /** 审核确认的模型输入/输出 token 硬上界；请求字段超出时被夹紧。 */
  maxModelInputTokens: number
  maxModelOutputTokens: number
  reviewedAt: string
  /** 审核来源，如代码评审记录或定价页快照路径。 */
  source: string
}

const PILOT_REVIEWED_PRICE_EVIDENCE = new Map<string, PilotReviewedPriceEvidence>()

/**
 * 首个经人工审核的真实价格证据（2026-09-28 依据官方页面核对）：
 * Z.ai GLM-5.3-Flash，OpenAI 兼容 Chat Completion；输入 $0.15/M、输出 $0.50/M（USD 计价），
 * 缓存输入 $0.03/M 更低不抬高上界；上下文 1M、最大输出 128K、思考不可关闭（计入输出）。
 * 同名模型在国内平台牌价 ¥0.80/¥2.80，USDCNY≥5.6 时同样被此 USD 上界覆盖；
 * 汇率或牌价变动须另增证据条目。请求必须纯文本且不得携带非 function 工具（derive 强制）。
 */
const ZAI_GLM_53_FLASH: PilotReviewedPriceEvidence = {
  evidenceId: 'zai-glm-5.3-flash-2026-09-28',
  providerKind: 'openai',
  model: 'glm-5.3-flash',
  inputMicrosPerMillion: 150_000,
  outputMicrosPerMillion: 500_000,
  extraCostCeilingMicros: 0,
  maxModelInputTokens: 1_000_000,
  maxModelOutputTokens: 131_072,
  reviewedAt: '2026-09-28',
  source: 'https://docs.z.ai/guides/overview/pricing; https://docs.z.ai/guides/llm/glm-5.3-flash',
}
validatePilotPriceEvidence(ZAI_GLM_53_FLASH)
PILOT_REVIEWED_PRICE_EVIDENCE.set(ZAI_GLM_53_FLASH.evidenceId, ZAI_GLM_53_FLASH)

function validatePilotPriceEvidence(evidence: PilotReviewedPriceEvidence): void {
  if (!evidence || typeof evidence.evidenceId !== 'string' || !evidence.evidenceId.trim()
    || !['openai', 'anthropic', 'google'].includes(evidence.providerKind)
    || typeof evidence.model !== 'string' || !evidence.model.trim()
    || typeof evidence.reviewedAt !== 'string' || !evidence.reviewedAt.trim()
    || typeof evidence.source !== 'string' || !evidence.source.trim()) {
    throw new Error('Pilot 价格证据身份字段无效')
  }
  const positive = [evidence.inputMicrosPerMillion, evidence.outputMicrosPerMillion,
    evidence.maxModelInputTokens, evidence.maxModelOutputTokens]
  if (positive.some((n) => !Number.isSafeInteger(n) || n <= 0)
    || !Number.isSafeInteger(evidence.extraCostCeilingMicros) || evidence.extraCostCeilingMicros < 0) {
    throw new Error('Pilot 价格证据数值字段无效')
  }
}

/** 仅供测试注入夹具价格；生产证据必须经代码评审写入本文件的注册表。 */
export function registerPilotPriceEvidenceForTests(evidence: PilotReviewedPriceEvidence): void {
  validatePilotPriceEvidence(evidence)
  PILOT_REVIEWED_PRICE_EVIDENCE.set(evidence.evidenceId, { ...evidence })
}

export function getPilotReviewedPriceEvidence(evidenceId: string): PilotReviewedPriceEvidence | undefined {
  return PILOT_REVIEWED_PRICE_EVIDENCE.get(evidenceId)
}

/** 最终 HTTP 请求体的精确字节指纹；body 必须与实际发送的序列化结果逐字节一致。 */
export function pilotRequestFingerprint(body: string): string {
  if (typeof body !== 'string' || body.length === 0) throw new Error('Pilot 请求体为空，拒绝生成指纹')
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

function readMaxOutputTokens(parsed: Record<string, unknown>, kind: PilotProviderKind): number | undefined {
  const read = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
  if (kind === 'google') {
    const config = parsed.generationConfig as Record<string, unknown> | undefined
    return read(config?.maxOutputTokens)
  }
  const legacy = read(parsed.max_tokens)
  const current = read(parsed.max_completion_tokens)
  if (legacy === undefined) return current
  if (current === undefined) return legacy
  return Math.min(legacy, current)
}

/** 请求必须纯文本：图片/文件等多模态内容的 token 数不受 body 字节数约束，会击穿输入上界。
 *  同时覆盖 OpenAI/Anthropic 的 messages[].content 与 google 的 contents[].parts。 */
function assertTextOnlyMessages(parsed: Record<string, unknown>): void {
  const messages = parsed.messages
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const content = (message as { content?: unknown } | null)?.content
      if (typeof content === 'string' || content === undefined || content === null) continue
      if (!Array.isArray(content)) throw new Error('Pilot 请求消息格式无法核验')
      for (const block of content) {
        if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text') {
          throw new Error('Pilot 请求包含多模态内容，输入无法用字节数约束，拒绝发送')
        }
      }
    }
  }
  const contents = parsed.contents
  if (Array.isArray(contents)) {
    for (const item of contents) {
      const parts = (item as { parts?: unknown } | null)?.parts
      if (!Array.isArray(parts)) continue
      for (const part of parts) {
        if (!part || typeof part !== 'object' || typeof (part as { text?: unknown }).text !== 'string') {
          throw new Error('Pilot 请求包含多模态内容，输入无法用字节数约束，拒绝发送')
        }
      }
    }
  }
}

/** 非 function 工具（如按次计费的内置 web_search）费用未审核，出现即拒绝。 */
function assertNoUnreviewedTools(parsed: Record<string, unknown>): void {
  if (!Array.isArray(parsed.tools)) return
  for (const tool of parsed.tools) {
    if (!tool || typeof tool !== 'object' || (tool as { type?: unknown }).type !== 'function') {
      throw new Error('Pilot 请求包含未审核的内置工具，可能产生额外费用')
    }
  }
}

/**
 * 从最终请求体与已审核价格证据生成请求包络：输出上限取请求字段与模型上界的较小值；
 * 输入上界用「token 数 ≤ UTF-8 字节数」（BPE 每个 token 至少 1 字节）再夹紧模型上限。
 * 请求体缺输出上限、模型标识缺失或与证据不一致、含多模态/未审核工具、JSON 无效时一律拒绝；
 * google 协议模型在 URL 中，须由受控出口核验后经 verifiedModel 传入，缺失即拒。
 */
export function derivePilotRequestEnvelope(input: { body: string; priceEvidenceId: string; verifiedModel?: string }):
  PilotRequestEnvelope {
  const evidence = getPilotReviewedPriceEvidence(input?.priceEvidenceId)
  if (!evidence) throw new Error('Pilot 价格证据未审核入库，拒绝生成请求包络')
  const body = input.body
  if (typeof body !== 'string' || body.length === 0) throw new Error('Pilot 请求体为空')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(body) as Record<string, unknown>
  } catch {
    throw new Error('Pilot 请求体不是有效 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Pilot 请求体不是有效的 JSON 对象')
  }
  const bodyModel = typeof parsed.model === 'string' ? parsed.model : undefined
  const verifiedModel = typeof input.verifiedModel === 'string' && input.verifiedModel.trim() ? input.verifiedModel : undefined
  const boundModel = bodyModel ?? verifiedModel
  if (boundModel === undefined || boundModel !== evidence.model
    || (bodyModel !== undefined && verifiedModel !== undefined && bodyModel !== verifiedModel)) {
    throw new Error('Pilot 请求缺少模型标识或与价格证据不一致')
  }
  assertTextOnlyMessages(parsed)
  assertNoUnreviewedTools(parsed)
  const declaredOutput = readMaxOutputTokens(parsed, evidence.providerKind)
  if (declaredOutput === undefined) throw new Error('Pilot 请求缺少强制输出上限，拒绝发送')
  if (declaredOutput <= 0) throw new Error('Pilot 请求输出上限无效')
  const inputTokenCeiling = Math.min(Buffer.byteLength(body, 'utf8'), evidence.maxModelInputTokens)
  const outputTokenCeiling = Math.min(declaredOutput, evidence.maxModelOutputTokens)
  return {
    inputTokenCeiling,
    outputTokenCeiling,
    inputRateMicrosPerMillion: evidence.inputMicrosPerMillion,
    outputRateMicrosPerMillion: evidence.outputMicrosPerMillion,
    extraCostCeilingMicros: evidence.extraCostCeilingMicros,
    priceEvidenceId: evidence.evidenceId,
    requestEvidenceId: pilotRequestFingerprint(body),
  }
}
