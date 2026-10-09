/**
 * Pi Runtime + DeepSeek 受控试点（R03）。
 *
 * 默认跳过。仅当设置 PROMA_PI_PILOT=1 与 PROMA_PI_PILOT_DEEPSEEK_KEY 时运行。
 * 授权范围：DeepSeek 两个模型，本地估算费用累计不超过 PROMA_PI_PILOT_CAP_USD（默认 0.6 美元，按约 ¥5 保守折算）。
 * 超过上限立即停止剩余运行并写明原因，由用户决定是否继续。
 *
 * 每个用例的通过判定由本文件独立核验（读取文件、运行 bun test），不采信模型自述。
 * 费用为本地价格表 × 请求 token 的估算，不是 Provider 账单；费用缺失记为未知，不记为 0。
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROVIDER_DEFAULT_URLS, type SDKMessage } from '@gravitas/shared'
import { buildElectronMock } from '../testing/electron-mock'

const enabled = process.env.PROMA_PI_PILOT === '1' && Boolean(process.env.PROMA_PI_PILOT_DEEPSEEK_KEY)
const tempConfigDir = mkdtempSync(join(tmpdir(), 'proma-pi-pilot-config-'))
process.env.PROMA_TEST_CONFIG_DIR = tempConfigDir

mock.module('electron', () => buildElectronMock())
mock.module('../attachment-service', () => ({
  isImageAttachment: () => false,
  getMimeType: () => 'application/octet-stream',
  readAttachmentAsBase64: () => '',
  deleteAttachment: () => {},
  deleteConversationAttachments: () => {},
  saveAttachment: async () => ({ path: '/tmp/mock', fileName: 'mock', mimeType: 'text/plain', size: 0 }),
  openFileDialog: async () => null,
}))
mock.module('../document-parser', () => ({
  isDocumentAttachment: () => false,
  extractTextFromAttachment: async () => '',
}))

const { PiAgentAdapter } = await import('./pi-agent-adapter')
const { closeProjectDb, initProjectDb } = await import('../project-sqlite-store')
type PilotQueryOptions = import('./pi-agent-adapter').PiAgentQueryOptions

/** 本地价格表（USD / 百万 token），来自 @earendil-works/pi-ai 的 deepseek 目录，计费保守忽略缓存折扣。 */
const PRICING: Record<string, { input: number; output: number }> = {
  'deepseek-flash': { input: 0.3, output: 1.2 },
  'deepseek-v4-pro': { input: 1.32, output: 3.96 },
}

interface PilotCase {
  id: string
  prompt: string
  files: Record<string, string>
  /** 返回 true 表示模型通过；由试点代码直接核验。 */
  verify: (dir: string, run: RunEvidence) => { pass: boolean; detail: string }
  /** 拒绝类用例：拒绝所有写入类工具调用。 */
  denyWrites?: boolean
}

interface RunEvidence {
  text: string
  toolCalls: Array<{ name: string; input: unknown }>
  toolErrors: number
  permissionDecisions: Array<{ name: string; allowed: boolean }>
  requests: number
  inputTokens: number
  outputTokens: number
  batchIncomplete: string[]
  stopReasons: string[]
  messageTypes: string[]
  errorTexts: string[]
}

function fileText(dir: string, file: string): string {
  return existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : ''
}
function bunTest(dir: string): { exitCode: number; output: string } {
  const result = spawnSync(process.execPath, ['test'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } })
  return { exitCode: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
const hasTool = (run: RunEvidence, name: string): boolean => run.toolCalls.some((call) => call.name === name)

const BIG_LINES = Array.from({ length: 2000 }, (_, i) => `filler line ${i} lorem ipsum dolor sit amet consectetur`)
BIG_LINES.splice(1000, 0, 'NEEDLE-KEY=ZETA-4412')

const CASES: PilotCase[] = [
  { id: 'text-ok', prompt: '请只回复 OK 两个字母，不要解释。', files: {},
    verify: (_d, run) => ({ pass: /^\s*OK\s*$/i.test(run.text), detail: run.text.slice(0, 80) }) },
  { id: 'read-secret', prompt: '读取 notes.txt，只回复其中 secret-code 的值。', files: { 'notes.txt': 'secret-code: AMBER-7731\n' },
    verify: (_d, run) => ({ pass: run.text.includes('AMBER-7731') && hasTool(run, 'Read'), detail: 'Read+值' }) },
  { id: 'grep-definition', prompt: '在当前目录中找出定义函数 alphaCalc 的文件名，只回复文件名。',
    files: { 'a.ts': 'export function alphaCalc() { return 1 }\n', 'b.ts': "import { alphaCalc } from './a'\nexport const v = alphaCalc()\n" },
    verify: (_d, run) => ({ pass: /^\s*a\.ts\s*$/.test(run.text), detail: run.text.slice(0, 80) }) },
  { id: 'write-new-file', prompt: '创建 out/summary.md，内容为一行：PILOT-DONE。', files: {},
    verify: (dir) => ({ pass: fileText(dir, 'out/summary.md').includes('PILOT-DONE'), detail: 'out/summary.md' }) },
  { id: 'edit-constant', prompt: '把 config.ts 中 LIMIT 的值从 3 改为 5。', files: { 'config.ts': 'export const LIMIT = 3\n' },
    verify: (dir) => { const t = fileText(dir, 'config.ts'); return { pass: t.includes('LIMIT = 5') && !t.includes('LIMIT = 3'), detail: t.trim() } } },
  { id: 'edit-missing-target', prompt: '把 config.ts 中 MAX 的值改为 9。', files: { 'config.ts': 'export const LIMIT = 3\n' },
    verify: (dir) => { const t = fileText(dir, 'config.ts'); return { pass: t === 'export const LIMIT = 3\n', detail: '文件应保持不变' } } },
  { id: 'bash-list', prompt: '用 shell 列出当前目录下的文件名，并用逗号分隔回复。', files: { 'x1.txt': '1', 'x2.txt': '2' },
    verify: (_d, run) => ({ pass: run.text.includes('x1.txt') && run.text.includes('x2.txt') && hasTool(run, 'Bash'), detail: 'Bash+文件名' }) },
  { id: 'deny-write', prompt: '创建 blocked.txt，内容为 hi。', files: {}, denyWrites: true,
    verify: (dir, run) => ({ pass: !existsSync(join(dir, 'blocked.txt')) && run.permissionDecisions.some((d) => !d.allowed), detail: '写入应被拒绝且未落盘' }) },
  { id: 'fix-bug', prompt: '修复 math.ts 中的 bug，使 bun test 通过。',
    files: { 'math.ts': 'export function add(a: number, b: number) { return a - b }\n', 'math.test.ts': "import { test, expect } from 'bun:test'\nimport { add } from './math'\ntest('add', () => expect(add(2, 3)).toBe(5))\n" },
    verify: (dir) => { const r = bunTest(dir); return { pass: r.exitCode === 0 && /1 pass/.test(r.output), detail: `bun test exit=${r.exitCode}` } } },
  { id: 'multi-file-rename', prompt: '把 a.ts 中的 oldName 重命名为 newName，并同步修改 b.ts，使 bun test 通过。',
    files: { 'a.ts': 'export const oldName = 1\n', 'b.ts': "import { oldName } from './a'\nexport const v = oldName + 1\n",
      'check.test.ts': "import { test, expect } from 'bun:test'\nimport { newName } from './a'\nimport { v } from './b'\ntest('v', () => expect(v).toBe(2))\nexpect(newName).toBe(1)\n" },
    verify: (dir) => { const r = bunTest(dir); const oldLeft = ['a.ts', 'b.ts'].some((f) => fileText(dir, f).includes('oldName')); return { pass: r.exitCode === 0 && !oldLeft, detail: `exit=${r.exitCode} oldLeft=${oldLeft}` } } },
  { id: 'long-context-needle', prompt: '文件 big.txt 中 NEEDLE-KEY 的值是什么？只回复值。', files: { 'big.txt': BIG_LINES.join('\n') + '\n' },
    verify: (_d, run) => ({ pass: /^\s*ZETA-4412\s*$/.test(run.text), detail: run.text.slice(0, 80) }) },
  { id: 'sum-two-files', prompt: '读取 a.txt 与 b.txt（各为一个整数），把两者之和写入 total.txt，只写数字。', files: { 'a.txt': '17\n', 'b.txt': '25\n' },
    verify: (dir) => ({ pass: fileText(dir, 'total.txt').trim() === '42', detail: fileText(dir, 'total.txt').trim() }) },
  { id: 'implement-slugify', prompt: '实现 slug.ts 中的 slugify 函数，使 bun test 全部通过。规则：转小写，非字母数字字符连续替换为单个连字符，去掉首尾连字符。',
    files: { 'slug.ts': 'export function slugify(input: string): string {\n  throw new Error("todo")\n}\n',
      'slug.test.ts': "import { test, expect } from 'bun:test'\nimport { slugify } from './slug'\ntest('basic', () => expect(slugify('Hello World')).toBe('hello-world'))\ntest('punct', () => expect(slugify('  A--b!! c ')).toBe('a-b-c'))\ntest('digits', () => expect(slugify('V2 Beta')).toBe('v2-beta'))\n" },
    verify: (dir) => { const r = bunTest(dir); return { pass: r.exitCode === 0 && /3 pass/.test(r.output), detail: `exit=${r.exitCode}` } } },
  { id: 'fix-two-bugs', prompt: '两个模块各有一个 bug，修复后 bun test 全部通过，不要修改测试文件。',
    files: { 'price.ts': 'export function total(items: number[]) { return items.reduce((a, b) => a + b, 1) }\n',
      'tax.ts': 'export function withTax(v: number) { return v * 1.1 + 1 }\n',
      'check.test.ts': "import { test, expect } from 'bun:test'\nimport { total } from './price'\nimport { withTax } from './tax'\ntest('total', () => expect(total([1, 2, 3])).toBe(6))\ntest('tax', () => expect(withTax(100)).toBeCloseTo(110, 5))\n" },
    verify: (dir) => { const r = bunTest(dir); return { pass: r.exitCode === 0, detail: `exit=${r.exitCode}` } } },
  { id: 'json-sum-answer', prompt: '读取 data.json 中 items 数组每个对象的 amount 字段并求和，把结果数字写入 answer.txt，只写数字。',
    files: { 'data.json': JSON.stringify({ items: [{ amount: 3 }, { amount: 9 }, { amount: 4.5 }] }, null, 2) },
    verify: (dir) => ({ pass: fileText(dir, 'answer.txt').trim() === '16.5', detail: fileText(dir, 'answer.txt').trim() }) },
  { id: 'batch-replace-four-files', prompt: '把当前目录下所有 .ts 文件中的 TODO_OLD 替换为 TODO_NEW（包括子目录），完成后不要留下任何 TODO_OLD。',
    files: { 'src/a.ts': 'const x = "TODO_OLD"\n', 'src/b.ts': '// TODO_OLD\nexport const y = 1\n', 'lib/c.ts': 'export const z = "TODO_OLD TODO_OLD"\n', 'd.ts': 'export {}\n// keep\n' },
    verify: (dir) => { const names = ['src/a.ts', 'src/b.ts', 'lib/c.ts']; const ok = names.every((f) => fileText(dir, f).includes('TODO_NEW') && !fileText(dir, f).includes('TODO_OLD')); return { pass: ok, detail: names.map((f) => fileText(dir, f).includes('TODO_OLD') ? 'left' : 'ok').join(',') } } },
  { id: 'edit-recover-quotes', prompt: '把 greet.ts 中的问候语从 hello 改为 hi。',
    files: { 'greet.ts': "export const greeting = 'hello'\nexport const name = 'x'\n" },
    verify: (dir) => { const t = fileText(dir, 'greet.ts'); return { pass: t.includes("'hi'") && !t.includes("'hello'") && t.includes("name = 'x'"), detail: (t.trim().split('\n')[0] ?? '') } } },
  { id: 'write-tests-then-run', prompt: '为 math.ts 中的 clamp(value, min, max) 编写 math.test.ts（至少 3 个用例，覆盖边界），然后运行 bun test 并确保通过。',
    files: { 'math.ts': 'export function clamp(value: number, min: number, max: number): number {\n  return Math.min(Math.max(value, min), max)\n}\n' },
    verify: (dir) => { const t = fileText(dir, 'math.test.ts'); const r = bunTest(dir); return { pass: r.exitCode === 0 && t.length > 0 && /test\(/.test(t), detail: `exit=${r.exitCode} testFile=${t.length > 0}` } } },
]

interface RunRecord {
  model: string
  caseId: string
  status: 'completed' | 'failed' | 'budget_stopped' | 'skipped'
  pass: boolean
  detail: string
  error?: string
  evidence?: Omit<RunEvidence, 'text'> & { textPreview: string }
  estimatedCostUsd: number
  cumulativeEstimatedCostUsd: number
  durationMs: number
}

function withoutText(evidence: RunEvidence): Omit<RunEvidence, 'text'> {
  const { text: _text, ...rest } = evidence
  return rest
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICING[model]
  if (!price) throw new Error(`缺少价格表：${model}`)
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000
}

function collectEvidence(messages: SDKMessage[]): RunEvidence {
  const evidence: RunEvidence = { text: '', toolCalls: [], toolErrors: 0, permissionDecisions: [], requests: 0, inputTokens: 0, outputTokens: 0, batchIncomplete: [], stopReasons: [], messageTypes: [], errorTexts: [] }
  for (const message of messages) if ((message as unknown as Record<string, unknown>)._partial !== true) evidence.messageTypes.push(message.type)
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>
    // 流式 partial 与最终消息内容重复：只统计 final，避免文本与工具调用被重复计数。
    if (record._partial === true) continue
    if (message.type === 'assistant') {
      const inner = record.message as { content?: Array<Record<string, unknown>>; usage?: { input_tokens?: number; output_tokens?: number } }
      evidence.requests += 1
      if (typeof inner === 'object' && inner) {
        const stop = (inner as { stop_reason?: unknown }).stop_reason
        if (typeof stop === 'string') evidence.stopReasons.push(stop)
      }
      const errorField = record.error as { message?: unknown } | undefined
      if (errorField && typeof errorField.message === 'string') evidence.errorTexts.push(errorField.message.slice(0, 160))
      evidence.inputTokens += inner.usage?.input_tokens ?? 0
      evidence.outputTokens += inner.usage?.output_tokens ?? 0
      // 答案取最后一条非空 assistant 文本；中间工具步骤里的说明文字不计入最终答案。
      const stepText = (inner.content ?? []).map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
      if (stepText.trim()) evidence.text = stepText
      for (const block of inner.content ?? []) {
        if (block.type === 'tool_use') evidence.toolCalls.push({ name: String(block.name), input: block.input })
      }
      const integrity = record.toolCallBatchIntegrity as { complete?: boolean; reasons?: string[] } | undefined
      if (integrity && integrity.complete === false) evidence.batchIncomplete.push(...(integrity.reasons ?? []))
    }
    if (message.type === 'user') {
      const inner = record.message as { content?: Array<Record<string, unknown>> }
      for (const block of inner.content ?? []) if (block.type === 'tool_result' && block.is_error) evidence.toolErrors += 1
    }
  }
  return evidence
}

const RESULT_DIR = process.env.PROMA_PI_PILOT_OUT ?? join(tmpdir(), 'proma-pi-pilot-results')
const CAP_USD = Number(process.env.PROMA_PI_PILOT_CAP_USD ?? '0.6')
const LEDGER_PATH = join(RESULT_DIR, 'ledger.json')
const REPORT_PATH = join(RESULT_DIR, 'report.json')
const MODELS = (process.env.PROMA_PI_PILOT_MODELS ?? 'deepseek-flash').split(',').map((m) => m.trim()).filter(Boolean)
const ONLY = new Set((process.env.PROMA_PI_PILOT_CASES ?? '').split(',').map((c) => c.trim()).filter(Boolean))

function readLedger(): { cumulativeUsd: number } {
  return existsSync(LEDGER_PATH) ? JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) : { cumulativeUsd: 0 }
}
function writeLedger(cumulativeUsd: number): void {
  writeFileSync(LEDGER_PATH, JSON.stringify({ cumulativeUsd, capUsd: CAP_USD, updatedAt: new Date().toISOString() }, null, 2))
}

const workRoots: string[] = []
afterAll(() => {
  closeProjectDb()
  for (const dir of workRoots) rmSync(dir, { recursive: true, force: true })
  rmSync(tempConfigDir, { recursive: true, force: true })
})

;(enabled ? describe : describe.skip)('Pi + DeepSeek 受控试点', () => {
  test('按模型与用例顺序运行，累计估算费用不超过上限', async () => {
    mkdirSync(RESULT_DIR, { recursive: true })
    // 项目库只在临时配置目录内初始化，不触碰真实 ~/.gravitas 数据。
    await initProjectDb()
    const records: RunRecord[] = []
    let cumulative = readLedger().cumulativeUsd
    let stopped = false
    const adapter = new PiAgentAdapter()
    const apiKey = process.env.PROMA_PI_PILOT_DEEPSEEK_KEY ?? ''
    const selected = CASES.filter((c) => ONLY.size === 0 || ONLY.has(c.id))

    for (const model of MODELS) {
      for (const pilotCase of selected) {
        const started = Date.now()
        if (stopped || cumulative >= CAP_USD) {
          stopped = true
          records.push({ model, caseId: pilotCase.id, status: 'budget_stopped', pass: false, detail: '累计估算费用已达上限，未运行', estimatedCostUsd: 0, cumulativeEstimatedCostUsd: cumulative, durationMs: 0 })
          continue
        }
        const dir = mkdtempSync(join(tmpdir(), `pi-pilot-${pilotCase.id}-`))
        workRoots.push(dir)
        for (const [file, content] of Object.entries(pilotCase.files)) {
          const target = join(dir, file)
          mkdirSync(join(target, '..'), { recursive: true })
          writeFileSync(target, content)
        }
        const messages: SDKMessage[] = []
        const permissionDecisions: Array<{ name: string; allowed: boolean }> = []
        let error: string | undefined
        try {
          const limit = Math.max(0.0001, CAP_USD - cumulative)
          const queryInput: PilotQueryOptions = {
            sessionId: `pi-pilot-${model}-${pilotCase.id}-${Date.now()}`,
            prompt: pilotCase.prompt,
            agentRuntime: 'pi',
            provider: 'deepseek',
            apiKey,
            // Pi 的 deepseek provider 走 Anthropic 兼容端点；与渠道默认值保持一致。
            baseUrl: PROVIDER_DEFAULT_URLS.deepseek,
            model,
            cwd: dir,
            permissionMode: 'bypassPermissions',
            runtimeBudgetLimitUsd: limit,
            canUseTool: async (name) => {
              const allowed = pilotCase.denyWrites ? !['Write', 'Edit', 'Bash'].includes(name) : true
              permissionDecisions.push({ name, allowed })
              return allowed ? { allowed: true } : { allowed: false, message: '试点策略拒绝写入类工具' }
            },
          }
          for await (const message of adapter.query(queryInput)) {
            messages.push(message)
          }
        } catch (caught) {
          error = caught instanceof Error ? caught.message.slice(0, 300) : String(caught).slice(0, 300)
        }
        const evidence = collectEvidence(messages)
        writeFileSync(join(RESULT_DIR, `${model}-${pilotCase.id}.final.json`), JSON.stringify(messages.filter((m) => (m as unknown as Record<string, unknown>)._partial !== true).map((m) => ({ type: m.type, summary: JSON.stringify(m).slice(0, 1200) })), null, 2))
        evidence.permissionDecisions = permissionDecisions
        const cost = estimateCost(model, evidence.inputTokens, evidence.outputTokens)
        cumulative += cost
        writeLedger(cumulative)
        let verdict = { pass: false, detail: error ?? '未核验' }
        if (!error) {
          try { verdict = pilotCase.verify(dir, evidence) } catch (caught) { verdict = { pass: false, detail: `核验异常：${String(caught).slice(0, 120)}` } }
        }
        records.push({
          model, caseId: pilotCase.id, status: error ? 'failed' : 'completed', pass: verdict.pass, detail: verdict.detail,
          error, estimatedCostUsd: cost, cumulativeEstimatedCostUsd: cumulative, durationMs: Date.now() - started,
          evidence: { ...withoutText(evidence), textPreview: evidence.text.slice(0, 200) },
        })
        writeFileSync(REPORT_PATH, JSON.stringify({ capUsd: CAP_USD, cumulativeEstimatedCostUsd: cumulative, records }, null, 2))
      }
    }
    writeFileSync(REPORT_PATH, JSON.stringify({ capUsd: CAP_USD, cumulativeEstimatedCostUsd: cumulative, stoppedByBudget: stopped, records }, null, 2))
    // 试点只记录事实，不以“全部通过”作为门禁；结果由报告解读。
    expect(records.length).toBeGreaterThan(0)
  }, 3_600_000)
})
