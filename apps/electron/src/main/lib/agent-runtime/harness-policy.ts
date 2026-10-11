/**
 * Harness 策略加载与 Provider 前校验（P01/P04 配置侧）。
 *
 * 配置位于 `~/.gravitas/harness-policy.json`：
 * - 文件缺失 → 使用默认策略（不自动写盘）。
 * - JSON 损坏 / 未知字段 / 非法强度 → 抛 HarnessPolicyError，**保留原件不覆写**，
 *   由调用方拒绝受控运行。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_RUNTIME_CAPABILITIES,
  DEFAULT_HARNESS_POLICY,
  HarnessPolicyError,
  assertRuntimeSatisfiesPolicy,
  buildRuntimeGaps,
  parseHarnessPolicy,
  type AgentRuntime,
  type HarnessPolicy,
  type HarnessPolicyState,
} from '@gravitas/shared'
import { getConfigDir } from '../config-paths'

export function getHarnessPolicyPath(): string {
  return join(getConfigDir(), 'harness-policy.json')
}

/** 加载策略；文件缺失返回默认策略，损坏/未知字段抛错（保留原件）。 */
export function loadHarnessPolicy(path: string = getHarnessPolicyPath()): HarnessPolicy {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_HARNESS_POLICY, guarantees: { ...DEFAULT_HARNESS_POLICY.guarantees } }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HarnessPolicyError('Harness 策略文件不是合法 JSON，已保留原件并拒绝受控运行', ['JSON 解析失败'])
  }
  return parseHarnessPolicy(parsed)
}

/** 在调用 Provider 前断言当前 Runtime 满足策略的 required 保证。 */
export function assertRuntimePolicy(runtime: AgentRuntime, path?: string): void {
  const policy = loadHarnessPolicy(path)
  assertRuntimeSatisfiesPolicy(runtime, AGENT_RUNTIME_CAPABILITIES[runtime], policy)
}

/** 供设置 UI 的只读状态：缺失/正常/损坏三态 + 各 runtime 缺口。 */
export function buildHarnessPolicyState(path: string = getHarnessPolicyPath()): HarnessPolicyState {
  try {
    const policy = loadHarnessPolicy(path)
    const missing = !existsSync(path)
    return { status: missing ? 'missing' : 'ok', path, policy, error: null, reasons: [], runtimeGaps: buildRuntimeGaps(policy, AGENT_RUNTIME_CAPABILITIES) }
  } catch (error) {
    const reasons = error instanceof HarnessPolicyError ? [...error.reasons] : []
    return {
      status: 'invalid',
      path,
      policy: null,
      error: error instanceof Error ? error.message : String(error),
      reasons,
      runtimeGaps: buildRuntimeGaps(null, AGENT_RUNTIME_CAPABILITIES),
    }
  }
}
