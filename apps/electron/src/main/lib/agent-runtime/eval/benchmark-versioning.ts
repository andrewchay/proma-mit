/**
 * Benchmark 版本治理：case 集合、rubric 或被测目标变化时必须递增版本。
 *
 * 存储值权威：历史 scoreboard 结果保持原版本绑定，不因规则变更而重算。
 * 本模块只做版本比较与漂移检测，不修改既有结果。
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getBenchmarkCaseStatementAssetsDir, getBenchmarksRootDir } from '../../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../../safe-file'
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
 * 冻结一条评测记录的基准来源。
 *
 * 只在写入评测时调用：版本、rubric 版本、定义哈希与三类输入来源一起落盘，
 * 后续配置变化不回填历史，这样「这条评测当时用的是哪份基准、哪批素材、哪个评判者、
 * 什么运行配置」可被核对，影子对比才有可信输入。
 *
 * `source` 缺失时对应哈希不写入（保留「来源未知」语义，而不是按空值当成一致）。
 */
export function freezeEvaluationDefinition(
  benchmark: import('./types').BenchmarkConfig,
  frozenAt: string = new Date().toISOString(),
  source?: { judge?: import('./types').JudgeIdentity | null; maxTurns?: number },
): import('./types').EvaluationDefinitionProvenance {
  const rubricVersion = benchmark.rubricVersion ?? 1
  const judgeHash = hashJudgeIdentity(source?.judge)
  return {
    version: benchmark.version ?? 1,
    rubricVersion,
    definitionHash: hashBenchmarkDefinition({
      cases: benchmark.cases,
      rubricVersion,
      targetAgentId: benchmark.targetAgentId,
      ...(benchmark.targetScope === undefined ? {} : { targetScope: benchmark.targetScope }),
    }),
    frozenAt,
    caseMaterialHash: hashBenchmarkCaseMaterial(benchmark.id, [...benchmark.cases, ...(benchmark.heldOutCases ?? [])]),
    runConfigHash: hashEvalRunConfig(benchmark, source?.maxTurns),
    ...(judgeHash === undefined ? {} : { judgeHash }),
  }
}

/**
 * 案例素材摘要：按 case 目录下参考文件的相对名与内容计算，缺省目录计入 `absent`。
 *
 * 与 caseTextRubricSha256（题目正文+评分规则）互补：那个锁定「问什么、怎么判」，
 * 这个锁定「给被测方看了哪些素材」。两者都一致才谈得上同一份评测输入。
 */
export function hashBenchmarkCaseMaterial(benchmarkId: string, caseIds: string[]): string {
  const digest = createHash('sha256')
  for (const caseId of normalize(caseIds)) {
    const assetsDir = getBenchmarkCaseStatementAssetsDir(benchmarkId, caseId)
    let entries: string[] = []
    try {
      entries = readdirSync(assetsDir).sort()
    } catch {
      digest.update(`${caseId}\u0000absent\u0000`)
      continue
    }
    for (const entry of entries) {
      const filePath = join(assetsDir, entry)
      try {
        const stat = lstatSync(filePath)
        if (stat.isSymbolicLink()) { digest.update(`${caseId}\u0000${entry}\u0000symlink\u0000`); continue }
        if (!stat.isFile()) { digest.update(`${caseId}\u0000${entry}\u0000non-file\u0000`); continue }
        digest.update(`${caseId}\u0000${entry}\u0000${createHash('sha256').update(readFileSync(filePath)).digest('hex')}\u0000`)
      } catch {
        digest.update(`${caseId}\u0000${entry}\u0000unreadable\u0000`)
      }
    }
  }
  return digest.digest('hex')
}

/** 评判实现摘要：只认同一评判配置；未记录评判者时返回 undefined（不得按一致处理）。 */
export function hashJudgeIdentity(judge: import('./types').JudgeIdentity | null | undefined): string | undefined {
  if (!judge) return undefined
  return createHash('sha256').update(JSON.stringify({
    kind: judge.kind,
    provider: judge.provider ?? null,
    modelId: judge.modelId ?? null,
    channelId: judge.channelId ?? null,
    independent: judge.independent,
  })).digest('hex')
}

/** 运行配置摘要：被测 runtime 与轮次上限；默认轮次与 evaluator 保持一致（12）。 */
export function hashEvalRunConfig(benchmark: import('./types').BenchmarkConfig, maxTurns?: number): string {
  return createHash('sha256').update(JSON.stringify({
    provider: benchmark.runtime?.provider ?? null,
    modelId: benchmark.runtime?.modelId ?? null,
    channelId: benchmark.runtime?.channelId ?? null,
    maxTurns: maxTurns ?? 12,
  })).digest('hex')
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

export interface BenchmarkVersionHistoryEntry {
  snapshot: BenchmarkVersionSnapshot
  recordedAt: number
  /** 记录时相对上一版的漂移发现。 */
  driftReasons: string[]
  latestScore?: number | null
}

interface BenchmarkVersionHistoryFile {
  version: 1
  entries: BenchmarkVersionHistoryEntry[]
}

function historyPath(benchmarkId: string): string {
  return join(getBenchmarksRootDir(), benchmarkId, 'version-history.json')
}

/** 读取版本历史；不存在返回空数组。 */
export function readBenchmarkVersionHistory(benchmarkId: string): BenchmarkVersionHistoryEntry[] {
  const path = historyPath(benchmarkId)
  if (!existsSync(path)) return []
  const parsed = readJsonFileSafe<BenchmarkVersionHistoryFile>(path)
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return []
  return parsed.entries
}

/**
 * 追加一条版本快照。同一版本号重复记录时覆盖该条，避免重复刷新产生堆叠。
 * 只记录定义元数据，不写入 case 正文或评分规则内容。
 */
export function recordBenchmarkVersionSnapshot(input: { benchmark: BenchmarkConfig; latestScore?: number | null; now?: number }): BenchmarkVersionHistoryEntry {
  const snapshot = readBenchmarkVersion(input.benchmark)
  const history = readBenchmarkVersionHistory(input.benchmark.id)
  const previous = history[history.length - 1]
  const drift = previous ? detectBenchmarkDrift(previous.snapshot, snapshot) : { drifted: false, reasons: [] }
  const entry: BenchmarkVersionHistoryEntry = { snapshot, recordedAt: input.now ?? Date.now(), driftReasons: drift.reasons, latestScore: input.latestScore ?? null }
  const entries = [...history.filter((item) => item.snapshot.version !== snapshot.version), entry].sort((left, right) => left.snapshot.version - right.snapshot.version)
  writeJsonFileAtomic(historyPath(input.benchmark.id), { version: 1, entries } satisfies BenchmarkVersionHistoryFile)
  return entry
}
