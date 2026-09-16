/**
 * Benchmark 版本治理：case 集合、rubric 或被测目标变化时必须递增版本。
 *
 * 存储值权威：历史 scoreboard 结果保持原版本绑定，不因规则变更而重算。
 * 本模块只做版本比较与漂移检测，不修改既有结果。
 */

import { createHash } from 'node:crypto'
import type { BenchmarkConfig } from './types'

/** 参与漂移判定、必须版本化的字段。 */
export interface BenchmarkVersionSnapshot {
  version: number
  rubricVersion: number
  cases: string[]
  heldOutCases: string[]
  targetType: string
  targetAgentId: string
  targetScope?: string
  targetWorkspaceId?: string
}

export interface BenchmarkDriftReport {
  drifted: boolean
  /** 影响复现性的字段差异；为空表示无漂移。 */
  reasons: string[]
}

function normalize(values: string[] | undefined): string[] {
  return [...(values ?? [])].sort()
}

export function readBenchmarkVersion(benchmark: BenchmarkConfig): BenchmarkVersionSnapshot {
  return {
    version: benchmark.version ?? 1,
    rubricVersion: benchmark.rubricVersion ?? 1,
    cases: normalize(benchmark.cases),
    heldOutCases: normalize(benchmark.heldOutCases),
    targetType: benchmark.targetType ?? 'agent',
    targetAgentId: benchmark.targetAgentId,
    targetScope: benchmark.targetScope,
    targetWorkspaceId: benchmark.targetWorkspaceId,
  }
}

/**
 * 比较两次快照。版本号未递增但影响复现性的内容变化时报告漂移。
 * 仅版本号递增本身不算漂移。
 */
export function detectBenchmarkDrift(previous: BenchmarkVersionSnapshot, next: BenchmarkVersionSnapshot): BenchmarkDriftReport {
  const reasons: string[] = []
  const same = (left: string[], right: string[]): boolean => left.length === right.length && left.every((value, index) => value === right[index])
  const contentChanged = !same(previous.cases, next.cases)
    || !same(previous.heldOutCases, next.heldOutCases)
    || previous.targetType !== next.targetType
    || previous.targetAgentId !== next.targetAgentId
    || previous.targetScope !== next.targetScope
    || previous.targetWorkspaceId !== next.targetWorkspaceId
    || previous.rubricVersion !== next.rubricVersion
  const versionBumped = next.version > previous.version
  const versionRolledBack = next.version < previous.version

  // 漂移仅指“内容变了但版本号没跟上”；已递增版本属于正常演进。
  if (contentChanged && !versionBumped) {
    if (!same(previous.cases, next.cases)) reasons.push('训练 case 集合已变化但版本号未递增')
    if (!same(previous.heldOutCases, next.heldOutCases)) reasons.push('held-out case 集合已变化但版本号未递增')
    if (previous.targetType !== next.targetType || previous.targetAgentId !== next.targetAgentId || previous.targetScope !== next.targetScope || previous.targetWorkspaceId !== next.targetWorkspaceId) reasons.push('被测目标已变化但版本号未递增')
    if (previous.rubricVersion !== next.rubricVersion) reasons.push('评分规则已变化但版本号未递增')
  }
  if (versionRolledBack) reasons.push('版本号不能回退')
  return { drifted: reasons.length > 0, reasons }
}

/** 内容 hash：用于判断两次 rubric 定义是否真的不同。 */
export function hashBenchmarkDefinition(input: { cases: string[]; rubricVersion: number; targetAgentId: string; targetScope?: string }): string {
  return createHash('sha256').update(JSON.stringify({ cases: normalize(input.cases), rubricVersion: input.rubricVersion, targetAgentId: input.targetAgentId, targetScope: input.targetScope ?? null })).digest('hex')
}

/** 决定下一版本号：内容变化时必须递增，否则保持。 */
export function nextBenchmarkVersion(previous: BenchmarkVersionSnapshot | null, changed: boolean): number {
  if (!previous) return 1
  return changed ? previous.version + 1 : previous.version
}
