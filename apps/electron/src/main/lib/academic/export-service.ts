/**
 * 可追溯导出包（M7.2）
 *
 * 方案 §14：导出**不是**打包一份漂亮的文档，而是交付「这份结论
 * 依据什么、缺什么、验证到什么程度」。因此本模块刻意做三件事：
 *
 * 1. **逐项列出验证等级**：来源是否核实、证据是否带定位、主张是否
 *    经研究者确认、产物是否有摘要——不做统一"完成度"分数。
 * 2. **显式列出缺失与缺口**：未处理的预检问题、unverified 产物、
 *    legacy/unverified 标记，全部写进 manifest 而不是隐藏。
 * 3. **排除受限内容**：不导出全文正文、身份映射、凭据、密钥；
 *    日志只导出摘要（字节数与哈希），不导出原始内容。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  Claim,
  EvidenceLink,
  ManuscriptVersion,
  ResearchProject,
  ResearchProtocol,
  ResearchRun,
  RunArtifact,
  RunObservation,
  SearchRunRecord,
  Source,
  TopicProposal,
} from '@gravitas/shared'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'
import { exportPreflight } from '@gravitas/core/services/academic'
import { getResearchDir } from './research-store'
import { assertProjectAccess } from './access-guard'

/** manifest 中的一个对象条目：只带身份与验证线索，不带正文 */
export interface ExportManifestEntry {
  kind: string
  id: string
  title?: string
  /** 该对象的验证等级（逐项判断，不合成总分） */
  verification: 'verified' | 'unverified' | 'not-applicable'
  /** 说明为什么是这个等级 */
  note?: string
  /** 关联的外部/内部标识（便于回溯） */
  refs?: string[]
}

export interface ExportManifest {
  manifestVersion: 1
  project: { id: string; title: string; domain: string; methodPath: string; status: string }
  exportedAt: string
  /** 交付物清单（含验证等级与缺口） */
  entries: ExportManifestEntry[]
  /** 明确的缺口/风险声明 */
  gaps: string[]
  /** 计数摘要（便于快速核对，不作为质量分） */
  counts: Record<string, number>
  /** 明确声明未导出的内容类型 */
  excluded: string[]
}

export interface ExportBundle {
  directory: string
  manifest: ExportManifest
  manifestPath: string
  reportPath: string
}

/**
 * 构造导出 manifest（纯函数，便于测试与复核）。
 *
 * 依赖项由调用方提供，避免本函数直接读盘——导出内容必须来自
 * 事件流重建后的真实对象，而不是重新查询可能已变化的当前状态。
 */
export function buildExportManifest(input: {
  project: ResearchProject
  sources: Source[]
  searchRuns: SearchRunRecord[]
  evidence: Array<{ id: string; sourceId: string; sourceVersionId: string; text: string; locator: { kind: string } }>
  observations: RunObservation[]
  runs: ResearchRun[]
  artifacts: RunArtifact[]
  protocols: ResearchProtocol[]
  topics: TopicProposal[]
  claims: Claim[]
  links: EvidenceLink[]
  manuscripts: ManuscriptVersion[]
  exportedAt?: string
}): ExportManifest {
  const entries: ExportManifestEntry[] = []
  const gaps: string[] = []

  // 来源：有外部标识视为身份可核；无标识标 unverified 并说明
  for (const source of input.sources) {
    const version = source.versions[0]
    const ids = version?.externalIds ?? []
    entries.push({
      kind: 'source',
      id: source.id,
      title: version?.title,
      verification: ids.length > 0 ? 'verified' : 'unverified',
      note:
        ids.length > 0
          ? `外部标识 ${ids.map((i) => `${i.namespace}:${i.value}`).join(', ')}`
          : '无外部标识（书籍/网页/材料等）：身份未自动核实',
      refs: ids.map((i) => `${i.namespace}:${i.value}`),
    })
  }
  if (input.sources.some((s) => (s.versions[0]?.externalIds ?? []).length === 0)) {
    gaps.push('存在无外部标识的来源：其身份需人工核实后才能作为主要依据')
  }
  if (input.sources.some((s) => s.versions[0]?.retrievalStatus !== 'full-text')) {
    gaps.push('部分来源仅有元数据/摘要（未获取全文）：基于其结论属初步依据')
  }

  // 证据：有定位器视为可回溯
  for (const ev of input.evidence) {
    entries.push({
      kind: 'evidence',
      id: ev.id,
      title: ev.text.slice(0, 60),
      verification: ev.locator ? 'verified' : 'unverified',
      note: `定位器：${ev.locator.kind}`,
      refs: [ev.sourceId, ev.sourceVersionId],
    })
  }
  const evidenceWithoutLocator = input.evidence.filter((e) => !e.locator)
  if (evidenceWithoutLocator.length > 0) {
    gaps.push(`有 ${evidenceWithoutLocator.length} 条证据缺少定位器，无法回溯原文`)
  }

  // 检索日志：记录覆盖与截断
  for (const run of input.searchRuns) {
    entries.push({
      kind: 'search-run',
      id: run.id,
      title: run.query,
      // 检索日志本身不是"证据"，但如果截断则覆盖不完整
      verification: run.truncated ? 'unverified' : 'not-applicable',
      note: run.truncated
        ? `结果被截断（返回 ${run.resultCount} 条）：检索覆盖不完整`
        : `返回 ${run.resultCount} 条；库：${run.databases.join(', ')}`,
      refs: run.databases,
    })
    if (run.truncated) {
      gaps.push(`检索「${run.query}」结果被截断，不能据此声称覆盖完整或不存在前人研究`)
    }
  }

  // 观察记录
  for (const obs of input.observations) {
    entries.push({
      kind: 'observation',
      id: obs.id,
      title: obs.text.slice(0, 60),
      verification: 'not-applicable',
      note: `记录人 ${obs.recordedBy.displayName}`,
      refs: [obs.runId],
    })
  }

  // 运行与产物
  for (const run of input.runs) {
    entries.push({
      kind: 'run',
      id: run.id,
      title: run.title,
      verification: run.status === 'completed' ? 'not-applicable' : 'unverified',
      // 关键声明：进程完成不等于结论成立
      note:
        run.status === 'completed'
          ? '进程正常结束；不代表结论成立'
          : `状态：${run.status}${run.statusReason ? `（${run.statusReason}）` : ''}`,
      refs: run.externalRef ? [`${run.externalRef.tool}:${run.externalRef.toolRunId}`] : undefined,
    })
  }
  for (const artifact of input.artifacts) {
    entries.push({
      kind: 'artifact',
      id: artifact.id,
      title: artifact.ref,
      verification: artifact.integrity === 'verified' ? 'verified' : 'unverified',
      note:
        artifact.integrity === 'verified'
          ? `本地文件已于导出前计算摘要（sha256:${artifact.digest?.slice(0, 12)}…）`
          : '外部引用：导出包不包含该产物实体，需自行获取',
      refs: [artifact.runId],
    })
  }
  if (input.artifacts.some((a) => a.integrity === 'unverified')) {
    gaps.push('存在未校验产物（外部引用）：导出包不含其实体，复现需另行获取')
  }

  // 协议与选题
  for (const protocol of input.protocols) {
    entries.push({
      kind: 'protocol',
      id: protocol.id,
      title: `协议 v${protocol.version}`,
      verification: protocol.status === 'approved' ? 'verified' : 'unverified',
      note: protocol.approval
        ? `由 ${protocol.approval.approvedBy.displayName} 批准`
        : `状态：${protocol.status}（未经批准）`,
    })
    if (protocol.status === 'approved') {
      // 批准只代表流程条件满足
      entries.push({
        kind: 'protocol-approval-note',
        id: `${protocol.id}-note`,
        verification: 'not-applicable',
        note: '协议批准表示流程门禁通过（字段/检查项/伦理依据齐全），不代表研究质量已达标',
      })
    }
  }
  const approvedProtocols = input.protocols.filter((p) => p.status === 'approved')
  if (approvedProtocols.length === 0) {
    gaps.push('没有已批准的协议版本：研究设计未经正式确认')
  }

  for (const topic of input.topics) {
    entries.push({
      kind: 'topic',
      id: topic.id,
      title: topic.title,
      verification: topic.status === 'selected' ? 'verified' : 'unverified',
      note: `gap 类型：${topic.gapType}${topic.selection ? `；由 ${topic.selection.selectedBy.displayName} 选定` : `；状态：${topic.status}`}`,
      refs: topic.noveltyCheck.closestSourceIds,
    })
  }

  // 主张与证据关联
  for (const claim of input.claims) {
    const own = input.links.filter((l) => l.claimId === claim.id)
    const supports = own.filter((l) => l.relation === 'supports').length
    const opposes = own.filter((l) => l.relation === 'opposes').length
    entries.push({
      kind: 'claim',
      id: claim.id,
      title: claim.text.slice(0, 80),
      verification: claim.status === 'researcher_verified' ? 'verified' : 'unverified',
      note: `状态：${claim.status}；支持 ${supports} / 反对 ${opposes}`,
    })
    if (claim.status !== 'researcher_verified') {
      gaps.push(`主张未确认：「${claim.text.slice(0, 40)}…」（状态 ${claim.status}）`)
    }
  }

  // 导出预检（逐条问题）
  const preflight = exportPreflight(input.claims, input.links)
  if (!preflight.ok) {
    for (const item of preflight.items) {
      gaps.push(`预检：${item.issue} —— 「${item.text.slice(0, 40)}…」`)
    }
  }

  // 稿件
  for (const ms of input.manuscripts) {
    entries.push({
      kind: 'manuscript',
      id: ms.id,
      title: `${ms.title}（v${ms.version}）`,
      verification: 'not-applicable',
      note: `章节 ${ms.sections.length} 节；创作者 ${ms.createdBy.displayName}`,
    })
  }
  if (input.manuscripts.length === 0) {
    gaps.push('尚无稿件版本')
  }

  const counts: Record<string, number> = {
    sources: input.sources.length,
    searchRuns: input.searchRuns.length,
    evidence: input.evidence.length,
    observations: input.observations.length,
    runs: input.runs.length,
    artifacts: input.artifacts.length,
    protocols: input.protocols.length,
    topics: input.topics.length,
    claims: input.claims.length,
    evidenceLinks: input.links.length,
    manuscripts: input.manuscripts.length,
    gaps: gaps.length,
  }

  return {
    manifestVersion: 1,
    project: {
      id: input.project.id,
      title: input.project.title,
      domain: input.project.domain,
      methodPath: input.project.methodPath,
      status: input.project.status,
    },
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    entries,
    gaps,
    counts,
    excluded: [
      '文献全文/PDF 正文（仅元数据、摘要与定位器）',
      '访谈原始音视频与身份映射（不可逆脱敏后才可另行导出）',
      'API 凭据、密钥与外部工具配置',
      '运行日志原文（仅记录字节数与哈希）',
      '受限级别（restricted）材料',
    ],
  }
}

/** 人类可读的导出报告（Markdown） */
export function renderExportReport(manifest: ExportManifest): string {
  const lines: string[] = []
  lines.push(`# 研究交付包：${manifest.project.title}`)
  lines.push('')
  lines.push(`- 研究项目 ID：\`${manifest.project.id}\``)
  lines.push(`- 领域 / 方法路径：${manifest.project.domain} / ${manifest.project.methodPath}`)
  lines.push(`- 导出时间：${manifest.exportedAt}`)
  lines.push(`- 项目状态：${manifest.project.status}`)
  lines.push('')
  lines.push('## 计数')
  lines.push('')
  for (const [key, value] of Object.entries(manifest.counts)) {
    lines.push(`- ${key}: ${value}`)
  }
  lines.push('')
  lines.push(`## 缺口与风险（${manifest.gaps.length}）`)
  lines.push('')
  if (manifest.gaps.length === 0) {
    lines.push('无未处理缺口。**注意：这不代表结论正确，仅表示流程记录完整。**')
  } else {
    for (const gap of manifest.gaps) lines.push(`- ${gap}`)
  }
  lines.push('')
  lines.push('## 对象与验证等级')
  lines.push('')
  lines.push('| 类型 | 标识 | 验证等级 | 说明 |')
  lines.push('|---|---|---|---|')
  for (const entry of manifest.entries) {
    lines.push(
      `| ${entry.kind} | \`${entry.id.slice(0, 8)}…\` | ${entry.verification} | ${(entry.note ?? '').replace(/\|/g, '／')} |`,
    )
  }
  lines.push('')
  lines.push('## 未包含的内容')
  lines.push('')
  for (const e of manifest.excluded) lines.push(`- ${e}`)
  lines.push('')
  lines.push('> 本导出包记录的是**过程可追溯性与已知缺口**，不是对研究结论正确性的证明。')
  return lines.join('\n')
}

/**
 * 导出研究包到指定目录（默认写入研究数据目录下的 exports/）。
 *
 * 只写 manifest.json 与 report.md 两个文件；不复制文献全文、
 * 不导出凭据、不导出运行日志原文。
 */
export async function exportResearchBundle(
  projectId: string,
  deps: {
    loadProject: (id: string) => Promise<ResearchProject | null>
    outputDir?: string
    exportedAt?: string
  },
): Promise<ExportBundle> {
  await assertProjectAccess(projectId, deps.loadProject)

  // 动态导入各服务，避免循环依赖
  const [
    { listSources, listSearchRuns },
    { listEvidence },
    { listRuns, listObservations, listArtifacts },
    { listProtocols },
    { listTopicProposals },
    { listClaims },
    { listManuscripts },
  ] = await Promise.all([
    import('./source-service'),
    import('./evidence-service'),
    import('./run-service'),
    import('./protocol-service'),
    import('./proposal-service'),
    import('./claim-service'),
    import('./claim-service'),
  ])

  const project = (await deps.loadProject(projectId))!
  const [sources, searchRuns, evidence, runs, observations, artifacts, protocols, topics, claims, manuscripts] =
    await Promise.all([
      listSources(projectId),
      listSearchRuns(projectId),
      listEvidence(projectId),
      listRuns(projectId),
      listObservations(projectId),
      listArtifacts(projectId),
      listProtocols(projectId),
      listTopicProposals(projectId),
      listClaims(projectId),
      listManuscripts(projectId),
    ])

  const manifest = buildExportManifest({
    project,
    sources,
    searchRuns,
    evidence: evidence.map((e) => ({
      id: e.id, sourceId: e.sourceId, sourceVersionId: e.sourceVersionId,
      text: e.text, locator: e.locator as { kind: string },
    })),
    observations,
    runs,
    artifacts,
    protocols,
    topics,
    claims: claims as unknown as Claim[],
    links: claims.flatMap((c) => c.links) as EvidenceLink[],
    manuscripts,
    exportedAt: deps.exportedAt,
  })

  const directory = resolve(deps.outputDir ?? join(getResearchDir(projectId), 'exports'))
  mkdirSync(directory, { recursive: true })

  const manifestPath = join(directory, 'manifest.json')
  const reportPath = join(directory, 'report.md')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  writeFileSync(reportPath, renderExportReport(manifest), 'utf-8')

  if (!existsSync(manifestPath)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '导出失败：manifest 未写入')
  }

  return { directory, manifest, manifestPath, reportPath }
}
