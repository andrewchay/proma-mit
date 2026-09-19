import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TypeSafeClient, choice } from '@typesafe-ai/sdk'

const MODEL = 'jev-1.13.0'

interface EvalCase {
  id: string
  kind: 'chat' | 'skill'
  message: string
  expected: string
}

const chatCriteria = {
  chat: '简短问答、解释、短文本翻译、日常讨论，Chat 可以直接完成。',
  agent_file_or_code: '需要读取、创建或修改本地文件、代码、配置，或运行测试与构建。',
  agent_multi_step_tools: '需要多个步骤、命令、外部工具、数据处理或持续迭代才能完成。',
  agent_research_or_browser: '需要系统调研、跨来源检索、受管浏览器操作或结构化研究产出。',
} as const

const skillCriteria = {
  no_skill: '当前请求不需要任何候选 Skill。',
  xlsx: '创建、读取、清洗、计算或格式化电子表格。',
  docx: '创建、读取或编辑 Word 文档。',
  pdf: '读取、创建或编辑 PDF。',
  pptx: '创建、读取或编辑 PowerPoint 演示文稿。',
  'web-design-engineer': '创建视觉化、交互式网页、仪表盘或前端原型。',
  'proma-gpt-image-2': '生成或编辑视觉图片、海报、封面或插图。',
} as const

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}

const apiKey = process.env.TYPESAFE_API_KEY?.trim()
if (!apiKey) {
  console.error('未运行：请显式设置 TYPESAFE_API_KEY 后再执行真实外部评测。')
  process.exit(2)
}

const fixturePath = join(import.meta.dir, 'fixtures', 'typesafe-routing-cases.json')
const cases = JSON.parse(readFileSync(fixturePath, 'utf8')) as EvalCase[]
const client = new TypeSafeClient({
  apiKey,
  defaultModel: MODEL,
  timeout: 5_000,
  retry: { maxRetries: 1 },
  logLevel: 'off',
})

let exact = 0
let chatFalsePositive = 0
let chatNegativeCount = 0
const latencies: number[] = []
const rows: Array<Record<string, string | number | boolean>> = []

for (const item of cases) {
  const startedAt = performance.now()
  const question = item.kind === 'chat'
    ? choice('判断当前请求应继续在 Chat 中回答，还是推荐切换到 Agent 模式。只按完成任务所必需的能力判断。', chatCriteria)
    : choice('选择完成该请求最相关的一个 Skill；没有匹配项时选择 no_skill。', skillCriteria)
  const result = await client.systemOne({
    model: MODEL,
    state: { user_request: item.message },
    questions: { route: question },
  })
  const latencyMs = Math.round(performance.now() - startedAt)
  latencies.push(latencyMs)
  const answer = result.answers.route
  const predicted = answer.choice
  const passed = predicted === item.expected
  if (passed) exact += 1
  if (item.kind === 'chat' && item.expected === 'chat') {
    chatNegativeCount += 1
    if (predicted !== 'chat') chatFalsePositive += 1
  }
  rows.push({
    id: item.id,
    expected: item.expected,
    predicted,
    probability: Number((answer.probabilities[predicted] ?? 0).toFixed(3)),
    confidence: Number(answer.confidence.toFixed(3)),
    latencyMs,
    passed,
  })
}

console.table(rows)
console.log(JSON.stringify({
  model: MODEL,
  cases: cases.length,
  exactMatch: Number((exact / cases.length).toFixed(3)),
  chatFalsePositiveRate: chatNegativeCount > 0
    ? Number((chatFalsePositive / chatNegativeCount).toFixed(3))
    : 0,
  p50LatencyMs: percentile(latencies, 0.5),
  p95LatencyMs: percentile(latencies, 0.95),
}, null, 2))
