/**
 * 研究运行规则（M4，纯函数无 IO）
 *
 * 安全边界（方案 §11.3）：**Electron 不执行模型生成的任意代码**。
 * 因此本层只允许：
 * - 解释器白名单（python3 / Rscript / node / bun）
 * - 脚本路径必须是项目目录内的相对路径（禁止绝对路径、`..` 穿越、盘符）
 * - 参数以数组传递，禁止 shell 拼接
 * - 必须声明超时与输出上限
 *
 * 进程实际创建在执行器（run-executor），本层只做形式校验与状态机。
 */

import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'
import type {
  RunBudget,
  RunInputManifest,
  ResearchRunStatus,
  ResearchRunKind,
} from '@gravitas/shared'

/** 允许的解释器（不含路径，只允许 PATH 中的这些名字） */
export const ALLOWED_INTERPRETERS = ['python3', 'python', 'Rscript', 'node', 'bun'] as const

/** 默认预算 */
export const DEFAULT_BUDGET: RunBudget = { timeoutMs: 10 * 60 * 1000, maxOutputBytes: 5 * 1024 * 1024 }

/** 预算硬上限（防止单次运行失控） */
export const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000
export const MAX_OUTPUT_BYTES = 200 * 1024 * 1024

const VALID_RUN_TRANSITIONS: Record<ResearchRunStatus, ResearchRunStatus[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['completed', 'failed', 'cancelled', 'timed-out'],
  completed: [],
  failed: [],
  cancelled: [],
  'timed-out': [],
}

export function assertRunTransition(from: ResearchRunStatus, to: ResearchRunStatus): void {
  if (!VALID_RUN_TRANSITIONS[from]?.includes(to)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_TRANSITION, `非法运行状态迁移: ${from} → ${to}`)
  }
}

export function isTerminalRunStatus(status: ResearchRunStatus): boolean {
  return VALID_RUN_TRANSITIONS[status].length === 0
}

/** 校验解释器在允许清单内 */
export function assertInterpreterAllowed(interpreter: string): void {
  if (!ALLOWED_INTERPRETERS.includes(interpreter as (typeof ALLOWED_INTERPRETERS)[number])) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `不允许的解释器「${interpreter}」；可选：${ALLOWED_INTERPRETERS.join(', ')}`,
    )
  }
}

/**
 * 校验脚本相对路径安全。
 *
 * 拒绝：绝对路径、`..` 穿越、Windows 盘符、空路径、以 `-` 开头
 * （避免被解释器当作选项）。
 */
export function assertSafeScriptPath(scriptPath: string): void {
  const p = scriptPath?.trim()
  if (!p) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '脚本路径不能为空')
  }
  if (/^[/\\]/.test(p) || /^[A-Za-z]:/.test(p)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `不允许绝对路径的脚本: ${p}`)
  }
  if (p.split(/[/\\]/).some((seg) => seg === '..')) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `脚本路径不允许包含上级目录引用: ${p}`)
  }
  if (p.startsWith('-')) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `脚本路径不得以 - 开头（会被解释器当作选项）: ${p}`)
  }
}

/** 校验参数：禁止控制字符；长度有界 */
export function assertSafeArgs(args: string[] | undefined): void {
  for (const arg of args ?? []) {
    if (typeof arg !== 'string') {
      throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '运行参数必须是字符串数组')
    }
    if (/[\u0000-\u001f]/.test(arg)) {
      throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '运行参数不允许包含控制字符')
    }
    if (arg.length > 4096) {
      throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '单个运行参数过长（≤4096 字符）')
    }
  }
}

/** 校验预算声明 */
export function validateBudget(budget: Partial<RunBudget> | undefined): RunBudget {
  const merged: RunBudget = { ...DEFAULT_BUDGET, ...(budget ?? {}) }
  if (!Number.isFinite(merged.timeoutMs) || merged.timeoutMs <= 0) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '超时必须是正数毫秒')
  }
  if (merged.timeoutMs > MAX_TIMEOUT_MS) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `超时不得超过 ${MAX_TIMEOUT_MS} ms`)
  }
  if (!Number.isFinite(merged.maxOutputBytes) || merged.maxOutputBytes <= 0) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '输出上限必须是正数字节')
  }
  if (merged.maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `输出上限不得超过 ${MAX_OUTPUT_BYTES} 字节`)
  }
  return merged
}

/**
 * 校验运行请求。
 *
 * compute：必须给解释器 + 脚本
 * manual-observation / tool-validation：不需要解释器
 */
export function validateRunRequest(input: {
  kind: ResearchRunKind
  title: string
  input: RunInputManifest
  budget?: Partial<RunBudget>
}): { input: RunInputManifest; budget: RunBudget } {
  if (!input.title?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '运行标题不能为空')
  }
  if (!['compute', 'manual-observation', 'tool-validation'].includes(input.kind)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `未知运行类型: ${String(input.kind)}`)
  }

  const manifest: RunInputManifest = { ...(input.input ?? {}) }

  if (input.kind === 'compute') {
    if (!manifest.interpreter) {
      throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '计算运行必须声明解释器')
    }
    assertInterpreterAllowed(manifest.interpreter)
    assertSafeScriptPath(manifest.scriptPath ?? '')
    assertSafeArgs(manifest.args)
  } else {
    // 非计算运行不允许夹带脚本，避免绕过 compute 的校验
    if (manifest.interpreter || manifest.scriptPath) {
      throw new ResearchError(
        RESEARCH_ERROR_CODES.INVALID_INPUT,
        `${input.kind} 类型不允许声明解释器/脚本；如需执行代码请使用 compute`,
      )
    }
  }

  return { input: manifest, budget: validateBudget(input.budget) }
}

/** 计算输入清单摘要（服务层用于事后比对；纯函数便于测试） */
export function digestInputManifest(input: RunInputManifest): string {
  const canonical = JSON.stringify({
    interpreter: input.interpreter ?? null,
    scriptPath: input.scriptPath ?? null,
    args: input.args ?? [],
    dataRefs: input.dataRefs ?? [],
    environmentNotes: input.environmentNotes ?? null,
  })
  // 简单稳定哈希（djb2 变体）——仅用于比对，不用于安全
  let h = 5381
  for (let i = 0; i < canonical.length; i++) {
    h = ((h << 5) + h + canonical.charCodeAt(i)) | 0
  }
  return `m4-${(h >>> 0).toString(16)}`
}
