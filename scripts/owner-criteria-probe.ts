/**
 * 真实模型下的目标硬要求追溯探针（第 2 步人工验收入口）。
 *
 * 存在的理由：单元测试只能证明「伪造来源会被拒」，不能证明「真实模型会不会漏」。
 * 本脚本把一次真实规划请求跑通，把模型的 criteriaTrace 与覆盖检查结果打印出来，
 * 由人核对五类硬要求是否都被承接。
 *
 * 用法：
 *   bun run scripts/owner-criteria-probe.ts <目标文件.txt> [--model deepseek-chat]
 *   bun run scripts/owner-criteria-probe.ts --inline "目标正文..." [--model ...]
 *   bun run scripts/owner-criteria-probe.ts --self-check      # 不调模型，验证脚本自身
 *
 * 凭证：从仓库根 `.env.local` 读取 PROBE_API_KEY / PROBE_BASE_URL / PROBE_MODEL。
 * 该文件已在 .gitignore 中，切勿提交。渠道配置（~/.gravitas-dev/channels.json）
 * 里的 apiKey 是 safeStorage 加密的，脚本无法解密，因此只作为渠道来源参考。
 * 不会写项目库、不创建任务、不产生执行授权。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
import { assessCriteriaCoverage } from '../apps/electron/src/main/lib/project-owner-criteria-trace'
import { buildProjectOwnerPlanningRequest, parseProjectOwnerPlanningResponse } from '../apps/electron/src/main/lib/project-owner-planning-protocol'
import type { ProjectOwnerGoalBrief, ProjectOwnerPlanningContext } from '@gravitas/shared'

/** 探针用的固定目标：包含五类硬要求，供人工核对是否被逐条承接。 */
const PROBE_GOAL = {
  objective: '制作一份书架盘点工作单，打印后供两名志愿者在现场使用',
  constraints: ['A4纸打印，四边15毫米边距', '现场需在45分钟内完成'],
  acceptanceCriteria: ['打印后必须为一页', '四个书架逐架复点并记录差异', '表格底部预留签字栏'],
}

const HARD_REQUIREMENTS = ['一页', '45分钟', '两名', '逐架', '签字']

/**
 * 读取 `.env.local` 中的键值对。
 *
 * 只支持最简形式 `KEY=value`，忽略空行与 `#` 注释；值两端的引号会被去掉。
 * 不覆盖已存在的进程环境变量，便于临时用环境变量覆盖。
 */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const result: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    let value = trimmed.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key && value && process.env[key] === undefined) result[key] = value
  }
  return result
}

interface ProbeCredential {
  apiKey: string
  baseUrl: string
  model: string
}

/**
 * 解析探针凭证。优先 `.env.local`，其次进程环境变量。
 *
 * 不接受 channels.json 里的 apiKey —— 那是 safeStorage 密文，拿去请求必然 401。
 */
function resolveCredential(): ProbeCredential {
  const fromFile = readEnvFile(join(REPO_ROOT, '.env.local'))
  const pick = (key: string): string | undefined => process.env[key] ?? fromFile[key]
  const apiKey = pick('PROBE_API_KEY')
  const baseUrl = pick('PROBE_BASE_URL')
  const model = pick('PROBE_MODEL')
  if (!apiKey) {
    throw new Error([
      '缺少 PROBE_API_KEY。请在仓库根创建 .env.local（已在 .gitignore 中），写入：',
      '  PROBE_API_KEY=你的密钥',
      '  PROBE_BASE_URL=https://open.bigmodel.cn/api/paas/v4',
      '  PROBE_MODEL=glm-4.6',
      'baseUrl 以 /anthropic 结尾时按 Anthropic 协议调用，否则按 OpenAI 兼容协议。',
    ].join('\n'))
  }
  if (!baseUrl) throw new Error('缺少 PROBE_BASE_URL（例如 https://open.bigmodel.cn/api/paas/v4）')
  if (!model) throw new Error('缺少 PROBE_MODEL（例如 glm-4.6）')
  return { apiKey, baseUrl, model }
}

function buildContext(goal: ProjectOwnerGoalBrief): ProjectOwnerPlanningContext {
  const sources = {
    project: { id: goal.projectId, title: '书架盘点', description: '' },
    roles: [{ key: 'requirements-analyst', name: '需求分析师', version: '1.0.0', sourceSha256: 'a'.repeat(64), rulesSha256: 'b'.repeat(64) }],
  }
  const fingerprint = new Bun.CryptoHasher('sha256')
    .update(JSON.stringify({ goalRevision: 1, goal, sources })).digest('hex')
  return { goal: { schemaVersion: 1, revision: 1, state: 'draft', actor: 'local-user', savedAt: Date.now(), goal }, sources, fingerprint }
}

/**
 * 渠道有两种协议：baseUrl 以 /anthropic 结尾走 Messages API，其余按 OpenAI Chat Completions。
 * 只用于本探针，不替代应用的 Provider 适配器。
 */
async function callModel(credential: ProbeCredential, systemPrompt: string, userPrompt: string): Promise<string> {
  const baseUrl = credential.baseUrl.replace(/\/$/, '')
  const { apiKey, model } = credential
  const anthropic = /\/anthropic$/.test(baseUrl)
  const url = anthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (anthropic) {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers.authorization = `Bearer ${apiKey}`
  }
  const response = await fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify(anthropic
      ? { model, max_tokens: 8192, temperature: 0, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }
      : { model, temperature: 0, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }),
  })
  if (!response.ok) throw new Error(`模型调用失败 ${response.status}：${(await response.text()).slice(0, 500)}`)
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>
    content?: Array<{ type?: string; text?: string }>
  }
  const content = anthropic
    ? payload.content?.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('')
    : payload.choices?.[0]?.message?.content
  if (!content) throw new Error('模型响应为空')
  return content
}

/** 从模型输出里取出 JSON（允许被 ```json 包裹）。 */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)```/)
  return JSON.parse((fenced?.[1] ?? raw).trim())
}

function report(trace: ReturnType<typeof assessCriteriaCoverage>, items: ReadonlyArray<{ key: string; sourceText: string; stepKey: string; verification: string }>): void {
  console.log('\n=== criteriaTrace（模型登记的硬要求）===')
  if (!items.length) console.log('（模型未登记任何追溯）')
  for (const item of items) {
    const flag = item.verification === 'unverified' ? '⚠ 未验证' : '✓'
    console.log(`  ${flag} [${item.stepKey}] ${item.sourceText}  (${item.verification})`)
  }
  console.log('\n=== 覆盖检查 ===')
  console.log(`  未承接：${trace.uncovered.length} 项`)
  for (const item of trace.uncovered) console.log(`    ✗ ${item.source}[${item.sourceIndex}] ${item.sourceText.slice(0, 60)}`)
  console.log(`  关键缺口：${trace.criticalUncovered}`)
  console.log(`  未验证：${trace.unverified.length} 项`)
}

function selfCheck(): void {
  const brief: ProjectOwnerGoalBrief = { projectId: 'probe', goalVersion: 1, ...PROBE_GOAL, codeSourceAccess: 'none' }
  const context = buildContext(brief)
  // 走真实入口：模型响应是 {schemaVersion, kind, binding, proposal} 外壳。
  const proposal = parseProjectOwnerPlanningResponse({
    schemaVersion: 1, kind: 'plan_proposal',
    projectId: 'probe', taskId: undefined, goalVersion: 1, contextFingerprint: context.fingerprint,
    proposal: {
      summary: '制作工作单', assumptions: [], risks: [],
      steps: [{ key: 'sheet', title: '工作单', outcome: '一页工作单', acceptanceCriteria: ['一页'], dependencies: [], roleKey: 'requirements-analyst', deliveryKind: 'text' }],
      criteriaTrace: [{ key: 'c1', source: 'acceptance', sourceIndex: 0, sourceText: '打印后必须为一页', criticality: 'critical', stepKey: 'sheet', verification: 'unverified', assumptions: ['A4与15mm'] }],
    },
  }, context)
  if (proposal.kind !== 'plan_proposal') throw new Error('自检失败：响应类型错误')
  const trace = proposal.proposal.criteriaTrace ?? []
  const coverage = assessCriteriaCoverage(brief, trace)
  // 来源共 6 条：objective 1 + constraints 2 + acceptanceCriteria 3；已覆盖 1 条，未承接 5 条。
  console.log('自检：追溯解析', trace.length === 1 ? '✓' : '✗')
  console.log('自检：未承接数应为 5 →', coverage.uncovered.length)
  if (trace.length !== 1 || coverage.uncovered.length !== 5) throw new Error('自检失败')
  console.log('自检通过。')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--self-check')) return selfCheck()
  const inlineIndex = args.indexOf('--inline')
  const goalFile = args.find((arg, index) => !arg.startsWith('--') && index !== inlineIndex + 1)

  const goal = inlineIndex >= 0
    ? { ...PROBE_GOAL, objective: args[inlineIndex + 1] ?? PROBE_GOAL.objective }
    : goalFile
      ? { ...PROBE_GOAL, objective: readFileSync(goalFile, 'utf8').trim() }
      : PROBE_GOAL
  if (!goal.objective.trim()) throw new Error('目标正文为空')

  const brief: ProjectOwnerGoalBrief = { projectId: 'probe', goalVersion: 1, ...goal, codeSourceAccess: 'none' }
  const context = buildContext(brief)
  const request = buildProjectOwnerPlanningRequest(context)
  const credential = resolveCredential()

  console.log(`模型：${credential.model}  baseUrl：${credential.baseUrl}`)
  console.log(`目标：${brief.objective}`)
  console.log(`约束：${JSON.stringify(brief.constraints)}`)
  console.log(`验收：${JSON.stringify(brief.acceptanceCriteria)}`)
  console.log('\n调用模型中...')

  const raw = await callModel(credential, request.systemPrompt, request.userPrompt)
  // 先落盘再解析：解析失败时原始响应仍然可查，否则无从判断是模型问题还是解析问题。
  await Bun.write('/tmp/owner-criteria-probe.raw.txt', raw)
  console.log(`\n原始响应已保存到 /tmp/owner-criteria-probe.raw.txt（${raw.length} 字符）`)

  let parsed: unknown
  try {
    parsed = extractJson(raw)
  } catch (cause) {
    console.error('\n=== 无法解析为 JSON ===')
    console.error(`原因：${cause instanceof Error ? cause.message : '未知错误'}`)
    console.error('\n--- 响应开头 800 字符 ---')
    console.error(raw.slice(0, 800))
    console.error('\n--- 响应结尾 400 字符 ---')
    console.error(raw.slice(-400))
    throw new Error('模型未返回可解析的 JSON，请查看 /tmp/owner-criteria-probe.raw.txt')
  }

  let response: ReturnType<typeof parseProjectOwnerPlanningResponse>
  try {
    response = parseProjectOwnerPlanningResponse(parsed, context)
  } catch (cause) {
    console.error('\n=== 协议校验失败 ===')
    console.error(`原因：${cause instanceof Error ? cause.message : '未知错误'}`)
    console.error('\n--- 模型原始输出 ---')
    console.error(raw.slice(0, 3000))
    throw cause
  }
  if (response.kind !== 'plan_proposal') {
    console.log(`\n模型返回了 ${response.kind}，不是计划提案：`)
    console.log(JSON.stringify(response, null, 2))
    return
  }
  const proposal = response.proposal

  console.log('\n=== 步骤 ===')
  for (const step of proposal.steps) console.log(`  [${step.key}] ${step.title} — ${step.outcome}`)

  const trace = proposal.criteriaTrace ?? []
  report(assessCriteriaCoverage(brief, trace), trace)

  console.log('\n=== 硬要求人工核对 ===')
  const joined = trace.map((item) => item.sourceText).join(' ')
  for (const word of HARD_REQUIREMENTS) {
    console.log(`  ${joined.includes(word) ? '✓' : '✗'} ${word}`)
  }

  console.log('\n原始响应已保存到 /tmp/owner-criteria-probe.raw.json')
  await Bun.write('/tmp/owner-criteria-probe.raw.json', raw)
}

await main()
