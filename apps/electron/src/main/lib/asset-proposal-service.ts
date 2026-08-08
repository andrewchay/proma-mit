/**
 * 资产提案服务 — Asset Proposal Service（PH2-D）
 *
 * 数据复利：把某次成功运行的证据沉淀为「可复用资产提案」
 * （Workflow 草稿建议 / Skill 定义建议），供用户确认后通过既有编辑器保存为正式资产。
 *
 * 数据源：evidence-service.buildSessionEvidence（从 token 记录得出工具顺序/写回/决策），
 * 不让模型联网，纯本地结构化生成，输出给 Agent 组织成提案文本。
 */

import { buildSessionEvidence } from './evidence-service'
import type { RunEvidence } from '@gravitas/shared'

export interface AssetProposal {
  /** 资产类型 */
  type: 'workflow' | 'skill'
  /** 建议标题（可取会话运行标题） */
  title: string
  /** 建议描述 */
  description: string
  /** 从证据提炼的关键步骤（workflow 节点 / skill 方法） */
  steps: string[]
  /** 建议的执行提示词（workflow agent 节点 prompt / skill 主体） */
  prompt: string
  /** 涉及的关键工具（供 workflow 能力声明） */
  keyTools: string[]
  /** 来源会话 */
  sessionId: string
  /** 证据摘要 */
  evidenceSummary: string
}

/**
 * 从某次成功会话的证据生成资产提案。
 * @param sessionId 成功运行会话
 * @param title 运行标题（可选，缺省用会话 id 前缀）
 */
export function proposeAssetFromRun(
  sessionId: string,
  title?: string,
  recordSource?: (q: import('@gravitas/shared').TokenUsageQuery) => import('@gravitas/shared').TokenUsageRecord[],
): AssetProposal | null {
  let evidence: RunEvidence
  try {
    evidence = buildSessionEvidence(sessionId, 'completed', undefined, recordSource)
  } catch {
    return null
  }

  const keyTools = (evidence.writeback ?? [])
    .map((w) => w.split(/(?=「|·|\s)/)[0]?.trim())
    .filter((s): s is string => Boolean(s))
    .slice(0, 12)

  const steps = buildSteps(evidence)
  if (steps.length === 0) {
    // 无足够写回/决策信息，不足以提炼可复用流程
    return null
  }

  const name = title?.trim() || `会话 ${sessionId.slice(0, 12)}`
  const description = evidence.evidence || `从成功会话「${name}」提炼的可复用方法`

  const prompt = (
    `请复现以下经过验证的工作方法（源自成功会话 ${sessionId.slice(0, 12)}）：\n` +
    steps.map((s, i) => `${i + 1}. ${s}`).join('\n') +
    (keyTools.length ? `\n\n关键工具：${keyTools.join('、')}` : '')
  )

  return {
    type: 'workflow',
    title: name,
    description,
    steps,
    prompt,
    keyTools,
    sessionId,
    evidenceSummary: evidence.evidence ?? description,
  }
}

/** 生成给用户/Agent 的可读提案摘要。 */
export function proposalToText(proposal: AssetProposal): string {
  const lines = [
    `【可复用资产提案 · ${proposal.type === 'workflow' ? 'Workflow' : 'Skill'}】`,
    `标题：${proposal.title}`,
    `描述：${proposal.description}`,
    `提炼步骤：`,
    ...proposal.steps.map((s, i) => ` ${i + 1}. ${s}`),
    `建议执行提示词：`,
    proposal.prompt,
  ]
  if (proposal.keyTools.length) lines.push(`关键工具：${proposal.keyTools.join('、')}`)
  return lines.join('\n')
}

function buildSteps(evidence: RunEvidence): string[] {
  const steps: string[] = []
  if (evidence.decisions?.length) {
    steps.push(...evidence.decisions.slice(0, 6).map((d) => `决策：${d}`))
  }
  if (evidence.writeback?.length) {
    steps.push(...evidence.writeback.slice(0, 6).map((w) => `产出/改动：${w}`))
  }
  if (evidence.validation) {
    steps.push(`验证：${evidence.validation}`)
  }
  return steps
}
