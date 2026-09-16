/**
 * 旧论文数据迁移（M1：仅 dry-run，不写任何新数据）
 *
 * 旧 academic-service 的 papers.json / artifacts/ 是用户已有数据。
 * 本模块先做只读检查，生成映射报告供用户确认；真正的迁移在用户
 * 批准后执行（后续里程碑）。不推断补造：旧数据缺什么就标什么。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AcademicPaper, LegacyPaperMapping, MigrationDryRunReport } from '@gravitas/shared'
import { getAcademicPapersPath, getAcademicArtifactsDir } from '../config-paths'

/** 读取旧论文索引；损坏不抛错，转为报告中的 warning（dry-run 不阻断） */
function readLegacyPapers(): { papers: AcademicPaper[]; readable: boolean; warning?: string } {
  const path = getAcademicPapersPath()
  if (!existsSync(path)) return { papers: [], readable: true }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { papers?: AcademicPaper[] }
    if (!Array.isArray(parsed.papers)) {
      return { papers: [], readable: false, warning: 'papers 字段不是数组' }
    }
    return { papers: parsed.papers, readable: true }
  } catch (err) {
    return {
      papers: [],
      readable: false,
      warning: `论文索引损坏：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** 评估单篇旧论文的可迁移性 */
function mapLegacyPaper(paper: AcademicPaper): LegacyPaperMapping {
  const missing: string[] = []
  if (!paper.content?.trim()) missing.push('content')
  if (!paper.stages?.length) missing.push('stages')

  // 旧 completed/integrity 分数按方案 §10.3 只作为历史标记，
  // 不自动变成 researcher_verified——所以有产出物也算 needs_review。
  const artifactsDir = getAcademicArtifactsDir()
  const kinds = ['integrity', 'peer-review', 'revision']
  const legacyArtifacts = kinds.map((kind) => ({
    kind,
    exists: existsSync(join(artifactsDir, `${paper.id}-${kind}.json`)),
  }))

  const action = missing.length > 0 ? 'needs_review' : 'migrate'
  return {
    paperId: paper.id,
    title: paper.title,
    action,
    target: 'ResearchProject + ManuscriptVersion',
    missing,
    legacyArtifacts,
  }
}

/** 只读迁移预检：不创建、不修改、不删除任何数据 */
export function dryRunLegacyPapersMigration(): MigrationDryRunReport {
  const papersPath = getAcademicPapersPath()
  const exists = existsSync(papersPath)
  const { papers, readable, warning } = readLegacyPapers()

  const warnings: string[] = []
  if (warning) warnings.push(warning)
  if (exists && readable && papers.length === 0) {
    warnings.push('旧论文索引为空：无需迁移')
  }

  return {
    papersPath,
    exists,
    readable,
    totalPapers: papers.length,
    mappings: papers.map(mapLegacyPaper),
    warnings,
  }
}
