/**
 * Reasoning Profile — 推理等级矩阵
 *
 * 让「思考模式」从全局布尔开关升级为按模型分级（off/low/medium/high/xhigh/max）：
 * - 每个模型族定义自己的可用等级与默认档
 * - 每个等级按协议族（anthropic-messages / openai-completions / openai-responses）
 *   映射为目标请求参数（reasoning_effort / output_config.effort / adaptive budget）
 *
 * 移植自 Proma 开源版（packages/shared/src/types/reasoning-profile.ts），
 * 按本项目 provider 集合裁剪 transport 归类。
 */

import type { ProviderType } from './channel'
import type { AgentThinkingLevel } from './agent'

/** 可识别的 reasoning 请求协议族。 */
export type ReasoningTransport =
  | 'anthropic-messages'
  | 'openai-completions'
  | 'openai-responses'
  | 'other'

/**
 * 将渠道归类到其实际的 reasoning 请求协议。
 *
 * 渠道名不能直接决定请求字段；profile 必须同时匹配模型 ID 和 transport，
 * 才能避免把 OpenAI 的 reasoning_effort 发送到 Anthropic endpoint。
 */
export function inferReasoningTransport(provider: ProviderType | undefined): ReasoningTransport {
  switch (provider) {
    case 'openai':
    case 'openai-responses':
    case 'zhipu':
    case 'doubao':
    case 'qwen':
    case 'xai':
    case 'custom':
      return provider === 'openai-responses' ? 'openai-responses' : 'openai-completions'
    case 'google':
      return 'other'
    default:
      return 'anthropic-messages'
  }
}

/** 编译器据此生成请求参数。 */
export type ReasoningEncodingKind =
  | 'adaptive-effort'
  | 'deepseek-output-effort'
  | 'openai-reasoning-effort'
  | 'zai-thinking-effort'

/** 每个产品等级映射为目标协议可接受的 effort 值。null 表示该等级在该协议下不可用。 */
export type ReasoningEffortMap = Partial<Record<AgentThinkingLevel, string | null>>

export interface ReasoningEncoding {
  kind: ReasoningEncodingKind
  effortMap: ReasoningEffortMap
}

export interface ReasoningProfile {
  id: 'deepseek-v4-flash' | 'deepseek-v4-pro' | 'kimi-k3' | 'glm-5.2' | 'glm-5.3' | 'openai-reasoning-standard' | 'openai-reasoning-max' | 'openai-reasoning-astra'
  levels: readonly AgentThinkingLevel[]
  defaultLevel: AgentThinkingLevel
  normalize(level: AgentThinkingLevel | undefined): AgentThinkingLevel
  encodings: Partial<Record<ReasoningTransport, ReasoningEncoding>>
}

export interface ResolveReasoningProfileInput {
  modelId: string | undefined
  transport: ReasoningTransport
}

// ===== 各模型族等级定义 =====

const DEEPSEEK_V4_LEVELS = ['off', 'low', 'high', 'xhigh', 'max'] as const satisfies readonly AgentThinkingLevel[]
const K3_LEVELS = ['off', 'low', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
const GLM_52_LEVELS = ['off', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
const GLM_53_LEVELS = ['low', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
/**
 * GLM-5.3 强制开启思考，深度由 reasoning_effort / output_config.effort 控制，
 * 故不向运行时暴露 off。
 */
const GLM_53_EFFORT_MAP: ReasoningEffortMap = {
  low: 'low',
  high: 'high',
  max: 'max',
}
const OPENAI_STANDARD_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly AgentThinkingLevel[]
const OPENAI_MAX_LEVELS = [...OPENAI_STANDARD_LEVELS, 'max'] as const satisfies readonly AgentThinkingLevel[]

// DeepSeek Anthropic 兼容端点只认 output_config.effort；off 用显式 disabled 表达。
const DEEPSEEK_V4_FLASH_EFFORT_MAP: ReasoningEffortMap = {
  minimal: null,
  low: 'low',
  medium: null,
  high: 'high',
  xhigh: 'high',
  max: 'max',
}
const DEEPSEEK_V4_PRO_EFFORT_MAP: ReasoningEffortMap = {
  minimal: null,
  low: 'high',
  medium: null,
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const K3_EFFORT_MAP: ReasoningEffortMap = {
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const GLM_52_OPENAI_EFFORT_MAP: ReasoningEffortMap = {
  minimal: null,
  low: 'high',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const GLM_52_ANTHROPIC_EFFORT_MAP: ReasoningEffortMap = {
  minimal: 'high',
  low: 'high',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

// OpenAI reasoning 模型：off 必须转 none，否则默认 medium。
const OPENAI_STANDARD_EFFORT_MAP: ReasoningEffortMap = {
  off: 'none',
  minimal: 'low',
  xhigh: 'xhigh',
}
const OPENAI_MAX_EFFORT_MAP: ReasoningEffortMap = {
  ...OPENAI_STANDARD_EFFORT_MAP,
  max: 'max',
}

// ===== 各模型族等级归一化 =====

function normalizeDeepSeekV4Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'off':
      return 'off'
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
      return 'xhigh'
    case 'max':
      return 'max'
    default:
      return 'high'
  }
}

function normalizeK3Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'off':
      return 'off'
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
      return 'max'
    default:
      return 'high'
  }
}

function normalizeGlm52Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  if (level === 'off') return 'off'
  return level === 'xhigh' || level === 'max' ? 'max' : 'high'
}

function normalizeGlm53Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'minimal':
    case 'low':
    case 'off':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
      return 'max'
    default:
      return 'max'
  }
}

function normalizeOpenAIStandardLevel(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  if (level === 'off') return 'off'
  if (level === 'minimal') return 'low'
  if (level === 'max') return 'xhigh'
  return level ?? 'high'
}

function normalizeOpenAIMaxLevel(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  if (level === 'minimal') return 'low'
  return level ?? 'high'
}

// ===== Profile 定义 =====

const DEEPSEEK_V4_FLASH_PROFILE: ReasoningProfile = {
  id: 'deepseek-v4-flash',
  levels: DEEPSEEK_V4_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeDeepSeekV4Level,
  encodings: {
    'anthropic-messages': { kind: 'deepseek-output-effort', effortMap: DEEPSEEK_V4_FLASH_EFFORT_MAP },
  },
}

const DEEPSEEK_V4_PRO_PROFILE: ReasoningProfile = {
  id: 'deepseek-v4-pro',
  levels: DEEPSEEK_V4_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeDeepSeekV4Level,
  encodings: {
    'anthropic-messages': { kind: 'deepseek-output-effort', effortMap: DEEPSEEK_V4_PRO_EFFORT_MAP },
  },
}

const K3_PROFILE: ReasoningProfile = {
  id: 'kimi-k3',
  levels: K3_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeK3Level,
  encodings: {
    'anthropic-messages': { kind: 'adaptive-effort', effortMap: K3_EFFORT_MAP },
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: K3_EFFORT_MAP },
  },
}

const GLM_53_PROFILE: ReasoningProfile = {
  id: 'glm-5.3',
  levels: GLM_53_LEVELS,
  defaultLevel: 'max',
  normalize: normalizeGlm53Level,
  encodings: {
    'anthropic-messages': { kind: 'adaptive-effort', effortMap: GLM_53_EFFORT_MAP },
    'openai-completions': { kind: 'zai-thinking-effort', effortMap: GLM_53_EFFORT_MAP },
  },
}

const GLM_52_PROFILE: ReasoningProfile = {
  id: 'glm-5.2',
  levels: GLM_52_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeGlm52Level,
  encodings: {
    'anthropic-messages': { kind: 'adaptive-effort', effortMap: GLM_52_ANTHROPIC_EFFORT_MAP },
    'openai-completions': { kind: 'zai-thinking-effort', effortMap: GLM_52_OPENAI_EFFORT_MAP },
  },
}

const OPENAI_STANDARD_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-standard',
  levels: OPENAI_STANDARD_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeOpenAIStandardLevel,
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: OPENAI_STANDARD_EFFORT_MAP },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: OPENAI_STANDARD_EFFORT_MAP },
  },
}

const OPENAI_MAX_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-max',
  levels: OPENAI_MAX_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeOpenAIMaxLevel,
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: OPENAI_MAX_EFFORT_MAP },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: OPENAI_MAX_EFFORT_MAP },
  },
}

const OPENAI_ASTRA_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-astra',
  levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultLevel: 'low',
  normalize: (level) => level === 'off' || level === 'minimal' ? 'low' : level ?? 'low',
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: { off: 'low', minimal: 'low', xhigh: 'xhigh', max: 'max' } },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: { off: 'low', minimal: 'low', xhigh: 'xhigh', max: 'max' } },
  },
}

export const REASONING_PROFILES: readonly ReasoningProfile[] = [
  DEEPSEEK_V4_FLASH_PROFILE,
  DEEPSEEK_V4_PRO_PROFILE,
  K3_PROFILE,
  GLM_52_PROFILE,
  GLM_53_PROFILE,
  OPENAI_STANDARD_PROFILE,
  OPENAI_MAX_PROFILE,
  OPENAI_ASTRA_PROFILE,
]

/**
 * 仅按模型 ID 匹配，再以实际 transport 确认该模型是否有已验证的协议 encoding。
 */
export function resolveReasoningProfile(input: ResolveReasoningProfileInput): ReasoningProfile | undefined {
  const modelId = input.modelId?.toLowerCase()
  if (!modelId) return undefined

  const isOpenAITransport = input.transport === 'openai-completions' || input.transport === 'openai-responses'
  const isOpenAIReasoningModel = !modelId.endsWith('-chat-latest')
    && (modelId.startsWith('gpt-5') || /^(o1|o3|o4)(?:-|$)/.test(modelId))
  if (modelId === 'gpt-6-astra') {
    return OPENAI_ASTRA_PROFILE.encodings[input.transport] ? OPENAI_ASTRA_PROFILE : undefined
  }
  const profile = /^deepseek-v4-flash(?:-|$)/.test(modelId)
    ? DEEPSEEK_V4_FLASH_PROFILE
    : /^deepseek-v4-pro(?:-|$)/.test(modelId)
      ? DEEPSEEK_V4_PRO_PROFILE
      : /^(?:k3(?:-256k)?|kimi-k3)$/.test(modelId)
        ? K3_PROFILE
        : modelId === 'glm-5.3' || modelId === 'glm-5.3-flash'
          ? GLM_53_PROFILE
          : modelId === 'glm-5.2'
            ? GLM_52_PROFILE
            : isOpenAITransport && isOpenAIReasoningModel
              ? /^gpt-5\.6(?:-|$)/.test(modelId) ? OPENAI_MAX_PROFILE : OPENAI_STANDARD_PROFILE
              : undefined

  return profile?.encodings[input.transport] ? profile : undefined
}

/** 请求档位不可用时优先向更高档位靠拢，再向低档位回退（与 Pi clampThinkingLevel 一致）。 */
const LEVEL_ORDER: readonly AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function normalizeReasoningCapabilityLevel(
  profile: ReasoningProfile | undefined,
  level: AgentThinkingLevel | undefined,
): AgentThinkingLevel {
  if (!profile) return level ?? 'high'
  const requested = level ?? profile.defaultLevel
  const normalized = profile.normalize(requested)
  if (profile.levels.includes(normalized)) return normalized

  // 部分模型（如 GLM-5.3）恒开思考、不暴露 off：把「关闭」请求保守升为 high，
  // 而不是静默降级到最低档。
  if (normalized === 'off') {
    return profile.levels.includes('high') ? 'high' : profile.defaultLevel
  }

  const requestedIndex = LEVEL_ORDER.indexOf(normalized)
  if (requestedIndex === -1) return profile.levels[0] ?? profile.defaultLevel
  for (let index = requestedIndex; index < LEVEL_ORDER.length; index += 1) {
    const candidate = LEVEL_ORDER[index]
    if (candidate && profile.levels.includes(candidate)) return candidate
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = LEVEL_ORDER[index]
    if (candidate && profile.levels.includes(candidate)) return candidate
  }
  return profile.levels[0] ?? profile.defaultLevel
}

/**
 * 把产品等级编码为目标协议的请求参数值。
 *
 * @returns effort 字符串；null 表示该等级在此协议下不可用（调用方应跳过该字段）
 */
export function encodeReasoningEffort(
  profile: ReasoningProfile,
  transport: ReasoningTransport,
  level: AgentThinkingLevel,
): string | null | undefined {
  const encoding = profile.encodings[transport]
  if (!encoding) return undefined
  return encoding.effortMap[level]
}
