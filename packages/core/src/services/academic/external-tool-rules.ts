/**
 * 外部工具集成规则（M6，纯函数无 IO）
 *
 * 方案 §7 的 adapter 契约与 §11.3 的安全边界：
 * - **不内置上游源码或二进制**：只登记描述符，用户自行安装
 * - **许可必须由用户显式确认**后才能启用（附条款链接）
 * - **版本必须固定**（用户填写实际版本），否则复现能力无从谈起
 * - `descriptor-only` 角色不得被当作可执行能力
 * - 执行一律走受限 CLI 调用（无 shell、超时、输出上限）
 */

import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'
import type { ExternalToolConfig, ExternalToolDescriptor, ExternalToolStatus } from '@gravitas/shared'

/** 解析版本号前缀（如 "orx 0.4.2" → "0.4.2"；无版本号则返回 undefined） */
export function parseVersion(output: string): string | undefined {
  const match = output.match(/\d+\.\d+(\.\d+)?([-.][\w.]+)?/)
  return match?.[0]
}

/** 校验描述符自洽性 */
export function validateToolDescriptor(descriptor: ExternalToolDescriptor): void {
  if (!descriptor.id?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '工具 id 不能为空')
  }
  if (!descriptor.name?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `工具 ${descriptor.id} 缺少名称`)
  }
  if (!descriptor.licenseNote?.trim() || !descriptor.homepage?.trim()) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `工具 ${descriptor.id} 必须提供许可说明与来源链接（用户需据此自行判断条款）`,
    )
  }
  if (descriptor.role === 'cli-adapter') {
    if (!descriptor.binary?.trim()) {
      throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `CLI adapter ${descriptor.id} 必须声明可执行文件名`)
    }
    if (/[/\\]/.test(descriptor.binary)) {
      throw new ResearchError(
        RESEARCH_ERROR_CODES.INVALID_INPUT,
        `工具 ${descriptor.id} 的 binary 只能是 PATH 中的可执行名，不接受路径`,
      )
    }
  }
  if (descriptor.role === 'descriptor-only' && descriptor.binary) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `描述符型工具 ${descriptor.id} 不应声明可执行文件（避免被误当作可执行能力）`,
    )
  }
}

/**
 * 判定工具可用状态。
 *
 * 顺序体现优先级：未启用 → 许可未确认 → 未安装 → 版本不符 → 可用。
 * 许可先于安装检查：即使用户装了工具，未确认条款也不得启用。
 */
export function resolveToolStatus(input: {
  descriptor: ExternalToolDescriptor
  config: ExternalToolConfig
  probe: { installed: boolean; version?: string; error?: string }
}): { status: ExternalToolStatus; detail?: string } {
  const { descriptor, config, probe } = input

  if (!config.enabled) {
    return { status: 'disabled', detail: '未启用（用户可在集成设置中启用）' }
  }
  if (!config.licenseAcknowledgedAt) {
    return { status: 'license-not-acknowledged', detail: `需先确认许可条款：${descriptor.licenseNote}` }
  }
  if (descriptor.role === 'descriptor-only') {
    return {
      status: 'disabled',
      detail: '该工具仅登记描述符（不提供内置执行路径），需按前置条件自行安装与调用',
    }
  }
  if (probe.error) {
    return { status: 'probe-error', detail: probe.error }
  }
  if (!probe.installed) {
    return { status: 'not-installed', detail: `未检测到可执行文件「${descriptor.binary}」；请按 ${descriptor.homepage} 自行安装` }
  }
  if (
    descriptor.expectedVersionPrefix &&
    probe.version &&
    !probe.version.startsWith(descriptor.expectedVersionPrefix)
  ) {
    return {
      status: 'version-mismatch',
      detail: `检测到版本 ${probe.version}，与期望前缀 ${descriptor.expectedVersionPrefix} 不符；请调整版本或更新期望`,
    }
  }
  return { status: 'available', detail: probe.version ? `检测到版本 ${probe.version}` : undefined }
}

/** 断言工具当前可被调用（否则抛出可读原因） */
export function assertToolUsable(view: { descriptor: ExternalToolDescriptor; status: ExternalToolStatus; detail?: string }): void {
  if (view.status !== 'available') {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `外部工具「${view.descriptor.name}」当前不可用（${view.status}）：${view.detail ?? '未说明原因'}`,
    )
  }
}

/** 校验启用请求：启用必须同时确认许可 */
export function validateToolEnableRequest(input: {
  enabled: boolean
  licenseAcknowledgedAt?: string
  pinnedVersion?: string
  descriptor: ExternalToolDescriptor
}): void {
  if (!input.enabled) return
  if (!input.licenseAcknowledgedAt) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `启用「${input.descriptor.name}」前必须确认许可条款：${input.descriptor.licenseNote}`,
    )
  }
  if (input.descriptor.role === 'cli-adapter' && !input.pinnedVersion?.trim()) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `启用「${input.descriptor.name}」需要填写实际安装版本（用于事后复现）`,
    )
  }
}
