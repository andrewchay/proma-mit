/**
 * 真实模型端到端验证（CLI 可跑，不依赖 Electron 渠道解密）。
 *
 * 目标：验证「评测 → Builder 候选 → accept」整条逻辑在真实 LLM 下能工作。
 * 传输层用 Proma Cloud（OpenAI 兼容）经 fetch 直接调用，避免依赖 Electron safeStorage 渠道。
 *
 * 运行： bun run apps/electron/src/main/lib/agent-runtime/eval/e2e-real.ts
 *
 * 说明：真正的产品路径（Electron 内）走 ProviderAgnosticAgentAdapter + safeStorage 渠道；
 * 本脚本用同一种 prompt/delegate 契约，仅替换传输层为真实 HTTP，用于验证真实模型表现与闭环逻辑。
 */

// @ts-ignore - allow top-level await under bun
import { join } from 'node:path'
// @ts-ignore
import { tmpdir } from 'node:os'
// @ts-ignore
import { rmSync, mkdirSync, existsSync } from 'node:fs'

const BASE = 'https://api.proma.cool'
const KEY = process.env.PROMA_CLOUD_KEY ?? 'pk_mjL7f59mP0BYKKBFQBpMG5euxEEKBb85vrNSIPcjwyE'
const MODEL = process.env.PROMA_MODEL ?? 'gpt-5.6-luna'

async function chat(system: string, user: string, maxTokens = 400): Promise<string> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ] }),
  })
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> }
  return data.choices?.[0]?.message?.content ?? ''
}

// 隔离配置，避免污染真实 ~/.gravitas
const testDir = join(tmpdir(), `gravitas-e2e-${Date.now()}`)
process.env.PROMA_TEST_CONFIG_DIR = testDir
mkdirSync(testDir, { recursive: true })

import { createBenchmark } from './benchmark-store'
import { evaluateCaseRun } from './evaluator'
import { selfEvolve, type StateGuard } from './self-evolver'
import type { BenchmarkConfig, Rubric, SelfEvolveChange } from './types'
import type { CaseEval } from './self-evolver'
import { buildBuilderUserPrompt } from './builder-prompts'

const REVIEWER_SYSTEM = '你是一个严格的代码审查子代理。审查给定代码，明确指出缺陷（含 file:line）、给出修复建议，输出格式包含严重程度分类。'

// 被测 Case 的 statement（非空，需符合子代理可执行任务）
const CASE_STATEMENT = `请审查 sandbox/review.js 的这段代码，找出其中的缺陷并给出修复建议，按严重程度分类输出，附上 file:line。`

const config: BenchmarkConfig = {
  id: `e2e-${Date.now().toString(36)}`,
  title: '真实模型端到端验证',
  description: '真实 LLM 审查 + Builder 优化 闭环',
  targetAgentId: 'code-reviewer',
  runtime: { provider: MODEL, modelId: MODEL },
  runsPerCase: 1,
  targetScore: 60,
  cases: ['CASE-001'],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const rubric: Rubric = {
  version: 1,
  items: [
    { name: '修复点', points: 35, check: '定位到缺陷位置' },
    { name: '缺陷', points: 40, check: '指出缺陷' },
    { name: '格式', points: 25, check: '提供 file:line 或修复建议' },
  ],
}

function e2eDelegate(reviewerSystem: string): (input: { task: string; workspaceDir: string }) => Promise<{ text: string }> {
  return async (input) => ({ text: await chat(reviewerSystem, input.task, 500) })
}

const current: { prompt: string } = { prompt: '默认审查指令' }

const state: StateGuard = {
  async snapshot() {},
  async apply(c: SelfEvolveChange) { current.prompt = (c.afterState as { prompt: string }).prompt },
  async restore() {},
  version: () => 1,
}

async function main(): Promise<void> {
  console.log(`[e2e] 模型=${MODEL} 端点=${BASE}`)
  createBenchmark(config, [{ caseId: 'CASE-001', statement: CASE_STATEMENT, rubric }])

  // Baseline：真实 LLM 作为被测审查员，规则打分（statement 交给被测方）
  const baseline = await evaluateCaseRun(config, 'CASE-001', 1, 1, e2eDelegate(REVIEWER_SYSTEM))
  console.log(`[e2e] BASELINE score=${baseline.score} status=${baseline.status}`)
  console.log('      被测审查样例:', (await chat(REVIEWER_SYSTEM, CASE_STATEMENT, 120)).slice(0, 90).replace(/\n/g, ' '))

  // 用 Evaluation 自己跑 selfEvolve，Builder 用真实 LLM 生成候选
  let builderCalls = 0
  const evaluateAt = async (def: unknown): Promise<CaseEval[]> => {
    if (def && typeof def === 'object') {
      const revised = (def as { prompt?: string }).prompt
      if (revised) current.prompt = revised
    }
    // 用真实 LLM 作为被测审查员，systemPrompt=候选/默认审查指令
    const r = await evaluateCaseRun(config, 'CASE-001', 1, 1, async () => ({ text: await chat(current.prompt, CASE_STATEMENT, 500) }))
    return [{ caseId: 'CASE-001', score: r.status === 'ok' ? r.score : null, sessionId: 's1' }]
  }

  const propose = async (input: { deficit: Array<{ caseId: string; score: number | null }>; round: number }) => {
    if (builderCalls >= 2) return null
    builderCalls++
    const user = buildBuilderUserPrompt({
      benchmark: config,
      currentPrompt: current.prompt,
      caseScores: input.deficit.map((d) => ({ caseId: d.caseId, score: d.score })),
    })
    const revised = await chat('你是 Agent 提示词优化器。直接输出改进后的审查系统提示词正文。', user, 500)
    if (!revised.trim() || revised === current.prompt) return null
    return { description: `e2e round${input.round}`, target: 'code-reviewer', afterState: { prompt: revised.trim() } }
  }

  const out = await selfEvolve({ benchmark: config, maxRounds: 2, propose, evaluate: evaluateAt, state })
  console.log('[e2e] 闭环结果:')
  console.log(`   baseline score=${out.baseline.totalScore.toFixed(2)}`)
  for (const r of out.rounds) {
    console.log(`   round v${r.agentVersion} score=${r.score.toFixed(2)} accepted=${r.accepted} rolledBack=${r.rolledBack} (${r.reason})`)
  }
  console.log(`   final=${out.finalScore.toFixed(2)}`)

  rmSync(testDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
}

void main().catch((e) => {
  console.error('[e2e] 失败:', e)
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* ignore */ }
  delete process.env.PROMA_TEST_CONFIG_DIR
  process.exit(1)
})
