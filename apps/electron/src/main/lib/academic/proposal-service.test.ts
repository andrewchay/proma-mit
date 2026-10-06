import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScholarAdapter } from './adapters/adapter-types'
import type { ResearchDomain, ResearchMethodPath } from '@gravitas/shared'

/**
 * 选题服务 + 七方向端到端联动验收（M3.2，方案 §13.1/§13.2）。
 *
 * 每个方向走完整链路：建项目 → 协议（按 profile 字段）→ 检索（假 adapter）
 * → 证据抽取 → 选题（gap/查新）→ 选定。断言各步门禁与记录完整性。
 * 全部离线、隔离在 PROMA_TEST_CONFIG_DIR。
 */

let tempDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'proposal-service-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

async function loadAll() {
  return {
    proposal: await import(`./proposal-service?t=${Math.random()}`),
    protocol: await import(`./protocol-service?t=${Math.random()}`),
    source: await import(`./source-service?t=${Math.random()}`),
    evidence: await import(`./evidence-service?t=${Math.random()}`),
    project: await import(`./research-service?t=${Math.random()}`),
  }
}

function fakeAdapter(id: string, count = 1): ScholarAdapter {
  return {
    databaseId: 'openalex',
    async search() {
      return {
        sources: Array.from({ length: count }, (_, i) => ({
          id: `${id}:${i}`,
          sourceId: '',
          versionLabel: 'published',
          externalIds: [{ namespace: 'doi' as const, value: `10.1/${id}${i}` }],
          title: `${id} 结果 ${i}`,
          authors: ['Author A'],
          retrievalStatus: 'abstract-only' as const,
          retrievedAt: '2026-09-16T10:00:00.000Z',
        })),
        truncated: false,
        errors: [],
      }
    },
  }
}

const novelty = {
  queries: ['hearing aid noise reduction listening effort'],
  databases: ['pubmed'],
  checkedAt: '2026-09-16T10:00:00.000Z',
  closestSourceIds: [],
  limitations: ['未覆盖非英文文献'],
}

describe('选题服务', () => {
  test('缺少查新范围或证据不存在时拒绝创建', async () => {
    const { proposal, project, evidence } = await loadAll()
    const p = await project.createResearchProject({
      title: '选题项目', domain: 'audiology', methodPath: 'quantitative',
    })

    await expect(
      proposal.createTopicProposal(p.id, {
        title: 'T', question: 'Q', gapType: 'conceptual', gapRationale: 'R',
        supportingEvidenceIds: [], contradictingEvidenceIds: [], counterarguments: [],
        noveltyCheck: { ...novelty, queries: [] },
      }),
    ).rejects.toThrow('检索词')

    await expect(
      proposal.createTopicProposal(p.id, {
        title: 'T', question: 'Q', gapType: 'conceptual', gapRationale: 'R',
        supportingEvidenceIds: ['ghost'], contradictingEvidenceIds: [], counterarguments: [],
        noveltyCheck: novelty,
      }),
    ).rejects.toThrow('支持证据不存在')

    expect(await evidence.listEvidence(p.id)).toHaveLength(0)
  })

  test('记录缺口存在时选定需 force；选定后其余候选保持 candidate', async () => {
    const { proposal, project, source, evidence, protocol } = await loadAll()
    const p = await project.createResearchProject({
      title: '选题项目2', domain: 'audiology', methodPath: 'quantitative',
    })
    await protocol.createProtocol(p.id, {
      methodPath: 'quantitative',
      fields: {
        population: 'p', intervention: 'i', comparator: 'c', outcomes: 'o',
        acousticCalibration: 'cal', estimand: 'e', samplingUnit: 's', sampleSizeRationale: 'n',
      },
    })
    await source.searchExternalSources(p.id, 'q', ['openalex'], { limit: 1 }, { adapters: [fakeAdapter('a', 1)] })
    const [src] = await source.listSources(p.id)
    const ev = await evidence.extractEvidence(p.id, {
      sourceId: src!.id,
      sourceVersionId: src!.versions[0]!.id,
      text: '原文片段',
      locator: { kind: 'page', page: 1 },
    })

    const draft = {
      title: '候选 A', question: 'Q', gapType: 'methodological' as const, gapRationale: 'R',
      supportingEvidenceIds: [ev.id], contradictingEvidenceIds: [], counterarguments: [],
      noveltyCheck: { ...novelty, closestSourceIds: [] },
    }
    const a = await proposal.createTopicProposal(p.id, draft)
    const b = await proposal.createTopicProposal(p.id, { ...draft, title: '候选 B' })

    // 有记录缺口（未记录反证/反例/最接近工作）→ 需 force
    await expect(proposal.selectTopicProposal(p.id, a.id)).rejects.toThrow('记录缺口')
    const selected = await proposal.selectTopicProposal(p.id, a.id, { force: true, reason: '先推进，后续补查新' })
    expect(selected.status).toBe('selected')
    expect(selected.selection?.selectedBy.id).toBe('local-user')

    const all = (await proposal.listTopicProposals(p.id)) as Array<{ id: string; status: string }>
    expect(all.find((x) => x.id === b.id)?.status).toBe('candidate')
  })

  test('否决需理由；已选定不能否决', async () => {
    const { proposal, project } = await loadAll()
    const p = await project.createResearchProject({
      title: '否决项目', domain: 'ai', methodPath: 'quantitative',
    })
    const c = await proposal.createTopicProposal(p.id, {
      title: 'C', question: 'Q', gapType: 'context-transfer', gapRationale: 'R',
      supportingEvidenceIds: [], contradictingEvidenceIds: [], counterarguments: [],
      noveltyCheck: novelty,
    })

    await expect(proposal.rejectTopicProposal(p.id, c.id, ' ')).rejects.toThrow('理由')
    await proposal.rejectTopicProposal(p.id, c.id, '与既有工作重复')
    const all = (await proposal.listTopicProposals(p.id)) as Array<{ id: string; status: string }>
    expect(all.find((x) => x.id === c.id)?.status).toBe('rejected')

    await expect(proposal.selectTopicProposal(p.id, c.id, { force: true })).rejects.toThrow('已被否决')
  })
})

// ===== 七方向端到端联动 =====

const DOMAIN_FIXTURES: Array<{
  domain: ResearchDomain
  methodPath: ResearchMethodPath
  fields: Record<string, string>
  checks: string[]
}> = [
  {
    domain: 'audiology',
    methodPath: 'quantitative',
    fields: {
      population: '成人听损', intervention: '降噪A', comparator: '降噪B', outcomes: 'SRT',
      acousticCalibration: '65 dB SPL', estimand: '差值', samplingUnit: '受试者', sampleSizeRationale: '功效0.8',
    },
    checks: ['ears-not-independent', 'unit-consistency', 'calibration-evidence', 'ceiling-floor'],
  },
  {
    domain: 'medical-humanities',
    methodPath: 'qualitative',
    fields: {
      positionality: '临床背景', materialSelection: '招募15人', codingStrategy: '主题分析',
      ethicsBasis: '批件 2026-ETH-01', dataRetention: '加密5年',
    },
    checks: ['no-fabricated-quotes', 'identity-separation', 'positionality-stated'],
  },
  {
    domain: 'statistics',
    methodPath: 'quantitative',
    fields: {
      estimand: '偏差', samplingUnit: '模拟数据集', sampleSizeRationale: '1000次重复',
      replicates: '1000', dataGeneratingMechanism: 'MCAR 20%',
    },
    checks: ['mc-error', 'seed-not-stability', 'prespecify-primary'],
  },
  {
    domain: 'ai',
    methodPath: 'quantitative',
    fields: {
      estimand: '准确率', samplingUnit: '评测集', sampleSizeRationale: '固定评测集',
      dataSplit: '固定划分+污染检查', baselines: 'BM25', computeBudget: '4 GPU 小时',
    },
    checks: ['contamination-check', 'budget-stop', 'negative-runs-visible'],
  },
  {
    domain: 'ontology',
    methodPath: 'formal',
    fields: {
      competencyQuestions: 'CQ1\nCQ2', scopeTerms: '听力学核心术语', validationPlan: '分层验证',
      format: 'RDF/OWL',
    },
    checks: ['competency-first', 'layered-validation', 'version-mapping'],
  },
  {
    domain: 'enterprise-ai',
    methodPath: 'mixed-practice',
    fields: {
      practiceGoal: '缩短检索时间', studyDesign: 'stepped-wedge', counterfactual: '同期未部署团队',
      baselineMetrics: '任务时间中位数', employeePrivacy: '匿名化+本地处理',
    },
    checks: ['no-causal-without-comparison', 'roi-traceable', 'sensitive-channel-check'],
  },
  {
    domain: 'data-science',
    methodPath: 'quantitative',
    fields: {
      dataDictionary: '字段/单位/缺失', validationStrategy: '时间切分', claimType: 'predictive',
      baselineModel: '移动平均',
    },
    checks: ['leakage-check', 'importance-not-causal', 'reproducible-pipeline'],
  },
]

describe('七方向端到端联动（离线 fixture）', () => {
  for (const fixture of DOMAIN_FIXTURES) {
    test(`${fixture.domain}：协议批准 → 检索 → 证据 → 选题选定`, async () => {
      const { proposal, protocol, source, evidence, project } = await loadAll()
      const p = await project.createResearchProject({
        title: `${fixture.domain} 样例`,
        domain: fixture.domain,
        methodPath: fixture.methodPath,
      })

      // 1) 协议：字段齐全 + 检查项确认 → 批准
      const proto = await protocol.createProtocol(p.id, {
        methodPath: fixture.methodPath,
        fields: fixture.fields,
      })
      const approved = await protocol.approveProtocol(p.id, proto.version, {
        acknowledgedChecks: fixture.checks,
      })
      expect(approved.status).toBe('approved')
      expect(approved.approval?.approvedBy.id).toBe('local-user')

      // 2) 检索（假 adapter）→ 3) 证据抽取
      const run = await source.searchExternalSources(
        p.id, 'topic query', ['openalex'], { limit: 1 }, { adapters: [fakeAdapter(fixture.domain, 1)] },
      )
      expect(run.importedSourceIds).toHaveLength(1)
      const [src] = await source.listSources(p.id)
      const ev = await evidence.extractEvidence(p.id, {
        sourceId: src!.id,
        sourceVersionId: src!.versions[0]!.id,
        text: '与选题相关的原文片段',
        locator: { kind: 'section', label: 'Results' },
      })

      // 4) 选题：记录较完整 → 可直接选定
      const topic = await proposal.createTopicProposal(p.id, {
        title: `${fixture.domain} 候选`,
        question: `${fixture.domain} 的研究问题？`,
        gapType: 'unstudied-comparison',
        gapRationale: '既有工作未覆盖该比较维度',
        supportingEvidenceIds: [ev.id],
        contradictingEvidenceIds: [],
        counterarguments: ['可能受样本量限制'],
        noveltyCheck: {
          queries: ['q1'], databases: ['openalex'],
          checkedAt: '2026-09-16T10:00:00.000Z',
          closestSourceIds: [src!.id], limitations: ['未覆盖商业数据库'],
        },
      })
      const selected = await proposal.selectTopicProposal(p.id, topic.id)
      expect(selected.status).toBe('selected')
    })
  }
})
