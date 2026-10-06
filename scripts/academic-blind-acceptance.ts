/**
 * 七领域端到端验收（M7.3）
 *
 *   bun scripts/academic-blind-acceptance.ts
 *
 * **命名与边界说明（重要）**：
 * 本脚本是「合成数据的端到端流程验收」，**不是**人工盲测，
 * 也不构成真实研究者可用性验证。之所以叫 acceptance 而不是盲测：
 * - 它使用与单元测试**不同**的一套数据（避免只针对单测夹具调通过）
 * - 它经公共 service API 走完整链路：项目 → 协议 → 检索 → 证据 →
 *   选题 → 运行 → 主张与证据矩阵 → 稿件 → 审查与修订 → 导出
 * - 它验证的是**门禁与记录完整性**，不是研究结论正确性
 *
 * 真实可用性验收需要真实研究者参与，不在本脚本能力范围内。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'academic-acceptance-'))
process.env.PROMA_TEST_CONFIG_DIR = tempDir

const BASE = '../apps/electron/src/main/lib/academic'
const research = await import(`${BASE}/research-service`)
const protocol = await import(`${BASE}/protocol-service`)
const source = await import(`${BASE}/source-service`)
const evidenceSvc = await import(`${BASE}/evidence-service`)
const proposal = await import(`${BASE}/proposal-service`)
const runSvc = await import(`${BASE}/run-service`)
const claimSvc = await import(`${BASE}/claim-service`)
const reviewSvc = await import(`${BASE}/review-service`)
const exportSvc = await import(`${BASE}/export-service`)

interface Scenario {
  domain: string
  methodPath: 'quantitative' | 'qualitative' | 'formal' | 'mixed-practice'
  protocolFields: Record<string, string>
  checks: string[]
  gapType: 'unstudied-comparison' | 'methodological' | 'conceptual' | 'contradictory-evidence'
  claimText: string
  /** 该领域特有的验收断言 */
  extraAssert?: (ctx: { projectId: string }) => Promise<string | null>
}

/** 与单元测试不同的数据（避免只针对夹具调通） */
const SCENARIOS: Scenario[] = [
  {
    domain: 'audiology',
    methodPath: 'quantitative',
    protocolFields: {
      population: '轻中度感音神经性听损成人（n=48）',
      intervention: '自适应降噪算法',
      comparator: '固定降噪强度',
      outcomes: 'SRT 与主观聆听负荷评分',
      acousticCalibration: '校准报告 CAL-2026-09，65 dB SPL 参考',
      estimand: '组间 SRT 差值（dB）',
      samplingUnit: '受试者（双耳为重复测量）',
      sampleSizeRationale: '功效分析：d=0.6, α=0.05, power=0.8 → n≈48',
    },
    checks: ['ears-not-independent', 'unit-consistency', 'calibration-evidence', 'ceiling-floor'],
    gapType: 'unstudied-comparison',
    claimText: '自适应降噪相比固定强度可降低主观聆听负荷',
    extraAssert: async ({ projectId }) => {
      // 听力学特有：拒稿前的完整性检查要求声学校准依据已提供
      const protocols = await protocol.listProtocols(projectId)
      const fields = protocols[0]!.fields
      return fields.acousticCalibration ? null : '缺少声学校准依据'
    },
  },
  {
    domain: 'medical-humanities',
    methodPath: 'qualitative',
    protocolFields: {
      positionality: '研究者为听力临床背景，关注患者主体经验',
      materialSelection: '目的抽样 12–15 名助听器使用者，半结构化访谈',
      codingStrategy: '反思性主题分析，含反例检索',
      ethicsBasis: '伦理批件 2026-ETH-114（含访谈与录音知情同意）',
      dataRetention: '脱敏后加密保存 5 年，音频单独隔离',
    },
    checks: ['no-fabricated-quotes', 'identity-separation', 'positionality-stated'],
    gapType: 'conceptual',
    claimText: '助听器使用中的污名体验影响佩戴依从性',
    extraAssert: async ({ projectId }) => {
      // 质性特有：方法论路径不应强制假设或随机种子
      const protocols = await protocol.listProtocols(projectId)
      const fields = protocols[0]!.fields
      if ('hypothesis' in fields || 'seed' in fields) return '质性协议被强加了假设/种子字段'
      return null
    },
  },
  {
    domain: 'statistics',
    methodPath: 'quantitative',
    protocolFields: {
      estimand: '缺失数据机制下处理效应的偏差与区间覆盖率',
      samplingUnit: '模拟数据集（独立重复）',
      sampleSizeRationale: '1,000 次重复以控制 Monte Carlo 误差',
      replicates: '1000',
      dataGeneratingMechanism: 'MAR（缺失依赖于已观测协变量）',
      missingDataPlan: '比较完整案例分析、MI、IPW 三种方法',
    },
    checks: ['mc-error', 'seed-not-stability', 'prespecify-primary'],
    gapType: 'methodological',
    claimText: '在 MAR 机制下多重插补的覆盖率优于完整案例分析',
  },
  {
    domain: 'ai',
    methodPath: 'quantitative',
    protocolFields: {
      estimand: '检索增强问答的引用支持率',
      samplingUnit: '固定评测集问题（每题独立）',
      sampleSizeRationale: '固定评测集 500 题，不做事后筛选',
      dataSplit: '训练/评测严格划分，已做 n-gram 污染检查',
      baselines: 'BM25 检索基线、无检索直答基线',
      computeBudget: '推理 4 GPU 小时上限',
      externalDependency: '商业模型 API 会更新：已标注复现等级受限',
    },
    checks: ['contamination-check', 'budget-stop', 'negative-runs-visible'],
    gapType: 'unstudied-comparison',
    claimText: '加入检索可提升引用支持率而不降低事实准确率',
  },
  {
    domain: 'ontology',
    methodPath: 'formal',
    protocolFields: {
      competencyQuestions: 'CQ1：某设备是否适用于给定听损类型？\nCQ2：某测量结果使用何种单位与校准口径？',
      scopeTerms: '人群、听力测量、设备、干预、结局五类术语及其来源',
      validationPlan: '分层：语法 → 逻辑一致性 → SHACL 约束 → 能力问题覆盖 → 专家语义审查',
      format: 'RDF/OWL',
      reuseSources: '术语映射参考 OLS；记录各来源许可',
    },
    checks: ['competency-first', 'layered-validation', 'version-mapping'],
    gapType: 'conceptual',
    claimText: '本体的五类术语可支撑听力学研究问题的结构化描述',
  },
  {
    domain: 'enterprise-ai',
    methodPath: 'mixed-practice',
    protocolFields: {
      practiceGoal: '缩短内部知识检索平均耗时',
      studyDesign: 'stepped-wedge',
      counterfactual: '同期尚未部署的团队作为对照',
      baselineMetrics: '任务完成时间中位数（改造前 8 周）',
      implementationFidelity: '实际使用率、培训覆盖率按周记录',
      employeePrivacy: '检索日志本地聚合，不上传个人查询内容',
    },
    checks: ['no-causal-without-comparison', 'roi-traceable', 'sensitive-channel-check'],
    gapType: 'context-transfer',
    claimText: '分阶段部署后任务完成时间中位数下降',
  },
  {
    domain: 'data-science',
    methodPath: 'quantitative',
    protocolFields: {
      dataDictionary: '来源、单位、缺失比例、异常与转换历史均已登记',
      validationStrategy: '时间序列切分（前 18 月训练，后 6 月验证），避免未来信息泄露',
      claimType: 'predictive',
      baselineModel: '季节性朴素预测',
    },
    checks: ['leakage-check', 'importance-not-causal', 'reproducible-pipeline'],
    gapType: 'methodological',
    claimText: '梯度提升模型在时间漂移下优于季节朴素基线',
  },
]

interface ScenarioResult {
  domain: string
  ok: boolean
  steps: string[]
  failures: string[]
  exportedGaps: number
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const steps: string[] = []
  const failures: string[] = []
  const step = (name: string, ok: boolean, detail?: string) => {
    steps.push(`${ok ? '✓' : '✗'} ${name}`)
    if (!ok) failures.push(`${name}${detail ? `：${detail}` : ''}`)
  }

  const project = await research.createResearchProject({
    title: `${scenario.domain} 验收`,
    domain: scenario.domain as never,
    methodPath: scenario.methodPath,
  })

  // 1) 协议：草稿 → 批准（门禁必须生效）
  const proto = await protocol.createProtocol(project.id, {
    methodPath: scenario.methodPath,
    fields: scenario.protocolFields,
  })
  let approvalBlockedAsExpected = false
  try {
    // 先故意不带检查项确认，验证门禁确实拦得住
    await protocol.approveProtocol(project.id, proto.version, { acknowledgedChecks: [] })
  } catch {
    approvalBlockedAsExpected = true
  }
  step('协议门禁拦截未确认检查项', approvalBlockedAsExpected)

  const approved = await protocol.approveProtocol(project.id, proto.version, {
    acknowledgedChecks: scenario.checks,
  })
  step('协议批准', approved.status === 'approved', `状态 ${approved.status}`)

  // 2) 文献检索（合成 adapter，不触网）
  const run = await source.searchExternalSources(
    project.id,
    `${scenario.domain} acceptance query`,
    ['openalex'],
    { limit: 2, sort: 'relevance', offset: 0 },
    {
      adapters: [
        {
          databaseId: 'openalex',
          async search() {
            return {
              sources: [
                {
                  id: 'acc:1', sourceId: '', versionLabel: 'published',
                  externalIds: [{ namespace: 'doi' as const, value: `10.5555/${scenario.domain}` }],
                  title: `${scenario.domain} 相关既有工作`, authors: ['Author A'],
                  retrievalStatus: 'abstract-only' as const, retrievedAt: '2026-09-17T00:00:00.000Z',
                },
              ],
              totalCount: 120, truncated: true, errors: [],
            }
          },
        },
      ],
    },
  )
  step('检索并记录每库明细', (run.databaseResults?.length ?? 0) === 1, '缺每库明细')

  const [src] = await source.listSources(project.id)
  step('来源落库（含外部标识）', Boolean(src), '未落库')

  // 3) 证据抽取（带定位器）
  const ev = await evidenceSvc.extractEvidence(project.id, {
    sourceId: src!.id,
    sourceVersionId: src!.versions[0]!.id,
    text: `${scenario.domain} 的关键原文片段`,
    locator: { kind: 'section', label: 'Results' },
  })
  let evidenceGateWorks = false
  try {
    await evidenceSvc.extractEvidence(project.id, {
      sourceId: src!.id, sourceVersionId: src!.versions[0]!.id, text: '无定位器片段',
      locator: { kind: 'page', page: 0 },
    })
  } catch {
    evidenceGateWorks = true
  }
  step('证据门禁拦截非法定位器', evidenceGateWorks)

  // 4) 选题：记录不完整时选定应被拦
  const topic = await proposal.createTopicProposal(project.id, {
    title: `${scenario.domain} 候选`,
    question: `${scenario.domain} 的研究问题？`,
    gapType: scenario.gapType as never,
    gapRationale: '既有工作未覆盖该比较/概念维度',
    supportingEvidenceIds: [ev.id],
    contradictingEvidenceIds: [],
    counterarguments: [],
    noveltyCheck: {
      queries: [`${scenario.domain} query`], databases: ['openalex'],
      checkedAt: '2026-09-17T00:00:00.000Z', closestSourceIds: [], limitations: [],
    },
  })
  let selectionGateWorks = false
  try {
    await proposal.selectTopicProposal(project.id, topic.id)
  } catch {
    selectionGateWorks = true
  }
  step('选题选定要求记录完整', selectionGateWorks)

  const selected = await proposal.selectTopicProposal(project.id, topic.id, { force: true, reason: '验收流程推进' })
  step('选题选定（显式确认缺口）', selected.status === 'selected')

  // 5) 运行记录：计算任务经受限执行器（用 node 跑一段无害脚本）
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const workdir = join(tempDir, 'academic', 'research', project.id, 'workdir')
  mkdirSync(workdir, { recursive: true })
  writeFileSync(join(workdir, 'analyze.js'), 'console.log("RESULT: ok")\n', 'utf8')

  const computeRun = await runSvc.createAndExecuteRun(
    project.id,
    {
      kind: 'compute', title: '验收分析脚本',
      input: { interpreter: 'node', scriptPath: 'analyze.js' },
      budget: { timeoutMs: 15000 },
    },
    { resolveProjectRoot: () => workdir },
  )
  step('受限执行器运行成功', computeRun.status === 'completed', `状态 ${computeRun.status}`)

  // 6) 主张与证据矩阵：无支持证据不得确认
  const claim = await claimSvc.createClaim(project.id, {
    text: scenario.claimText,
    type: scenario.domain === 'ontology' ? 'theoretical' : 'empirical',
  })
  let verifyGateWorks = false
  try {
    await claimSvc.setClaimStatus(project.id, claim.id, 'researcher_verified')
  } catch {
    verifyGateWorks = true
  }
  step('无支持证据不得确认主张', verifyGateWorks)

  await claimSvc.linkEvidence(project.id, { claimId: claim.id, relation: 'supports', evidenceId: ev.id })
  await claimSvc.setClaimStatus(project.id, claim.id, 'needs_review')
  const verified = await claimSvc.setClaimStatus(project.id, claim.id, 'researcher_verified', { note: '验收确认' })
  step('有支持证据后可确认', verified.status === 'researcher_verified')

  // 7) 稿件版本与 diff
  const ms1 = await claimSvc.createManuscriptVersion(project.id, {
    title: `${scenario.domain} 稿件`,
    sections: [{ heading: '结果', content: '初稿结论。', claimIds: [claim.id] }],
  })
  const ms2 = await claimSvc.createManuscriptVersion(project.id, {
    title: `${scenario.domain} 稿件`,
    sections: [{ heading: '结果', content: '修订后的结论表述。', claimIds: [claim.id] }],
    changeReason: '回应审稿意见，收敛表述',
  })
  const diff = await reviewSvc.compareManuscriptVersions(project.id, ms1.id, ms2.id)
  const diffOk = diff.sections.some((s) => s.change === 'modified')
  step('稿件版本 diff 识别修改', diffOk)

  // 8) 审查：规则检查 vs 模型建议来源区分
  const ruleFinding = await reviewSvc.recordRuleFinding(project.id, {
    message: '结果章节缺少效应量区间',
    rule: 'results-effect-size-interval',
    measured: 'absent',
    severity: 'warning',
  })
  const llmFinding = await reviewSvc.recordLlmFinding(project.id, {
    message: '建议补充与既有工作的对比讨论',
    model: 'acceptance-model',
    rationale: '讨论章节未提及最接近的既有工作',
    severity: 'error', // 故意传 error，验证被降级
  })
  step('规则检查保持 error/warning 语义', ruleFinding.kind === 'rule-lint')
  step('模型建议被降级为 warning', llmFinding.severity === 'warning', `实得 ${llmFinding.severity}`)

  // 9) 审稿意见与修订回复
  const comment = await reviewSvc.recordReviewerComment(project.id, {
    reviewerName: 'Reviewer A', content: '请补充效应量区间', severity: 'major',
  })
  let responseGateWorks = false
  try {
    await reviewSvc.respondToReviewerComment(project.id, {
      commentId: comment.id, status: 'addressed', response: '已补充',
    })
  } catch {
    responseGateWorks = true
  }
  step('「已处理」必须指出稿件版本', responseGateWorks)

  await reviewSvc.respondToReviewerComment(project.id, {
    commentId: comment.id, status: 'addressed', response: '已在修订版补充效应量区间',
    manuscriptVersionId: ms2.id,
  })
  const draft = await reviewSvc.buildResponseToReviewersDraft(project.id)
  step('回复草稿声明不代表审稿人认可', draft.disclaimer.includes('不代表审稿人认可'))

  // 10) 导出交付包（含缺口与排除声明）
  const bundle = await exportSvc.exportResearchBundle(project.id, {
    loadProject: (id: string) => research.getResearchProject(id),
    outputDir: join(tempDir, 'exports', scenario.domain),
  })
  step('导出 manifest 含排除声明', bundle.manifest.excluded.length > 0)
  step('导出未产生统一完成度分数', !JSON.stringify(bundle.manifest).includes('overallScore'))

  // 领域特有断言
  if (scenario.extraAssert) {
    const problem = await scenario.extraAssert({ projectId: project.id })
    step('领域特有断言', problem === null, problem ?? undefined)
  }

  return {
    domain: scenario.domain,
    ok: failures.length === 0,
    steps,
    failures,
    exportedGaps: bundle.manifest.gaps.length,
  }
}

// ===== 执行 =====

console.log('\n=== 学术研究七领域端到端验收（合成数据）===')
console.log('说明：这是流程与门禁验收，不是人工盲测；不代表研究结论正确性。\n')

const results: ScenarioResult[] = []
for (const scenario of SCENARIOS) {
  try {
    results.push(await runScenario(scenario))
  } catch (err) {
    results.push({
      domain: scenario.domain,
      ok: false,
      steps: [],
      failures: [`流程异常：${err instanceof Error ? err.message : String(err)}`],
      exportedGaps: 0,
    })
  }
}

for (const r of results) {
  console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.domain}（导出缺口 ${r.exportedGaps} 项）`)
  for (const s of r.steps) console.log(`       ${s}`)
  for (const f of r.failures) console.log(`       ✗ ${f}`)
  console.log('')
}

const passed = results.filter((r) => r.ok).length
console.log(`合计 ${results.length} 个领域，通过 ${passed}，未通过 ${results.length - passed}`)
console.log('\n边界说明：')
console.log('- 本脚本验证门禁与记录完整性，不验证研究结论正确性')
console.log('- 数据为合成数据，非真实研究者盲测')
console.log('- 真机联调（orx/dvc）、打包启动、人工标注评测均不在此范围')

rmSync(tempDir, { recursive: true, force: true })
process.exit(passed === results.length ? 0 : 1)
