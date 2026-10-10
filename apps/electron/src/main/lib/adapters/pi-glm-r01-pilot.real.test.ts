/**
 * R01：GLM-5.3-Flash，30个固定任务 × 调度启用/全串行基线 = 30对。
 * 默认跳过，需 PROMA_PI_PILOT=1 和 PROMA_PI_PILOT_GLM_KEY。
 * 2026-10-10 用户授权人民币10元。请求前保守预留，成功完整usage结算；未知及失败不释放；
 * 输出限制2048 token，超预算/长输入拒绝发送。预留不是Provider账单；实际费用保持unknown。
 * 基线只是当前构建的全串行模式，不是历史发布版本；冲突场景为额外验证，不计入30对。
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { GlmR01Budget } from './glm-r01-budget'
import { normalizeGlmR01Request } from './glm-r01-request'
import { observeGlmR01Usage } from './glm-r01-usage'
import { matchesNumericAnswer, captureRunDiagnostics, type GlmRunDiagnostics } from './glm-r01-verification'
import { getFetchFn } from '../proxy-fetch'
import { getEffectiveProxyUrl } from '../proxy-settings-service'
import { PROVIDER_DEFAULT_URLS, type SDKMessage } from '@gravitas/shared'
import { buildElectronMock } from '../testing/electron-mock'

const enabled = process.env.PROMA_PI_PILOT === '1' && Boolean(process.env.PROMA_PI_PILOT_GLM_KEY)
const tempConfigDir = mkdtempSync(join(tmpdir(), 'proma-glm-r01-config-'))
process.env.PROMA_TEST_CONFIG_DIR = tempConfigDir

mock.module('electron', () => buildElectronMock())
// 真实模型、真实工具保留；桌面入口不属于headless试点，禁止启动后台同步和窗口。
mock.module('../../index', () => ({ getMainWindow: () => null }))
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
const { setToolSchedulerDisabled, schedulerMetricsSnapshot } = await import('../agent-runtime/tool-scheduler-service')
const { closeProjectDb, initProjectDb } = await import('../project-sqlite-store')
type PilotQueryOptions = import('./pi-agent-adapter').PiAgentQueryOptions

interface RunEvidence {
  text: string
  toolCalls: Array<{ name: string }>
  toolErrors: number
  permissionDecisions: Array<{ name: string; allowed: boolean }>
  requests: number
  inputTokens: number
  outputTokens: number
  errorTexts: string[]
  toolErrorTexts: string[]
}

interface PilotCase {
  id: string
  prompt: string
  files: Record<string, string>
  /** 必需的 required-tool（recall 统计）；空数组表示无工具要求（纯文本任务）。 */
  requiredTools: string[]
  verify: (dir: string, run: RunEvidence) => { pass: boolean; detail: string }
  denyWrites?: boolean
}

function fileText(dir: string, file: string): string {
  return existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : ''
}
const hasTool = (run: RunEvidence, name: string): boolean => run.toolCalls.some((call) => call.name === name)

const CASES: PilotCase[] = [
  { id: 'text-ok', prompt: '请只回复 OK 两个字母，不要解释。', files: {}, requiredTools: [],
    verify: (_d, run) => ({ pass: /^\s*OK\s*$/i.test(run.text), detail: run.text.slice(0, 80) }) },
  { id: 'read-secret', prompt: '读取 notes.txt，只回复其中 secret-code 的值。', files: { 'notes.txt': 'secret-code: AMBER-7731\n' }, requiredTools: ['Read'],
    verify: (_d, run) => ({ pass: run.text.includes('AMBER-7731') && hasTool(run, 'Read'), detail: 'Read+值' }) },
  { id: 'grep-definition', prompt: '在当前目录中找出定义函数 alphaCalc 的文件名，只回复文件名。',
    files: { 'a.ts': 'export function alphaCalc() { return 1 }\n', 'b.ts': "import { alphaCalc } from './a'\nexport const v = alphaCalc()\n" }, requiredTools: [],
    verify: (_d, run) => ({ pass: /a\.ts/.test(run.text), detail: run.text.slice(0, 80) }) },
  { id: 'write-new-file', prompt: '创建 out/summary.md，内容为一行：PILOT-DONE。', files: {}, requiredTools: ['Write'],
    verify: (dir) => ({ pass: fileText(dir, 'out/summary.md').includes('PILOT-DONE'), detail: 'out/summary.md' }) },
  { id: 'edit-constant', prompt: '把 config.ts 中 LIMIT 的值从 3 改为 5。', files: { 'config.ts': 'export const LIMIT = 3\n' }, requiredTools: ['Edit'],
    verify: (dir) => { const t = fileText(dir, 'config.ts'); return { pass: t.includes('LIMIT = 5') && !t.includes('LIMIT = 3'), detail: t.trim() } } },
  { id: 'bash-list', prompt: '用 shell 列出当前目录下的文件名，并用逗号分隔回复。', files: { 'x1.txt': '1', 'x2.txt': '2' }, requiredTools: ['Bash'],
    verify: (_d, run) => ({ pass: run.text.includes('x1.txt') && run.text.includes('x2.txt') && hasTool(run, 'Bash'), detail: 'Bash+文件名' }) },
  { id: 'deny-write', prompt: '创建 blocked.txt，内容为 hi。', files: {}, requiredTools: [], denyWrites: true,
    verify: (dir, run) => ({ pass: !existsSync(join(dir, 'blocked.txt')) && run.permissionDecisions.some((d) => !d.allowed), detail: '写入应被拒绝且未落盘' }) },
  { id: 'sum-two-files', prompt: '读取 a.txt 与 b.txt（各为一个整数），把两者之和写入 total.txt，只写数字。', files: { 'a.txt': '17\n', 'b.txt': '25\n' }, requiredTools: ['Read', 'Write'],
    verify: (dir) => ({ pass: matchesNumericAnswer(fileText(dir, 'total.txt'), 42), detail: fileText(dir, 'total.txt').trim() }) },
]

interface TransformCase {
  id: string
  prompt: string
  files: Record<string, string>
  expected: string
  numeric?: boolean
}
const TRANSFORMS: TransformCase[] = [
  { id: 'json-sum', numeric: true, prompt: '求 data.json 的 amount 之和', files: { 'data.json': '[{"amount":3},{"amount":9},{"amount":4.5}]' }, expected: '16.5' },
  { id: 'json-max', numeric: true, prompt: '求 data.json 数组的最大值', files: { 'data.json': '[4,19,-2,7]' }, expected: '19' },
  { id: 'json-min', numeric: true, prompt: '求 data.json 数组的最小值', files: { 'data.json': '[4,19,-2,7]' }, expected: '-2' },
  { id: 'json-average', numeric: true, prompt: '求 data.json 数组的平均值', files: { 'data.json': '[2,4,9]' }, expected: '5' },
  { id: 'json-count', numeric: true, prompt: '求 data.json 数组中 active=true 的对象数量', files: { 'data.json': '[{"active":true},{"active":false},{"active":true}]' }, expected: '2' },
  { id: 'csv-total', numeric: true, prompt: '求 data.csv 的 quantity 列之和', files: { 'data.csv': 'name,quantity\na,3\nb,8\nc,2\n' }, expected: '13' },
  { id: 'csv-price', numeric: true, prompt: '计算 data.csv 所有行 price*qty 的总和', files: { 'data.csv': 'price,qty\n2,3\n4,2\n' }, expected: '14' },
  { id: 'sort-integers', prompt: '将 nums.txt 的整数升序排序，用英文逗号连接且无空格', files: { 'nums.txt': '9 2 5 -1' }, expected: '-1,2,5,9' },
  { id: 'deduplicate', prompt: '将 words.txt 按首次出现顺序去重，用英文逗号连接且无空格', files: { 'words.txt': 'a b a c b' }, expected: 'a,b,c' },
  { id: 'uppercase', prompt: '将 text.txt 全部转成大写', files: { 'text.txt': 'hello world' }, expected: 'HELLO WORLD' },
  { id: 'lowercase', prompt: '将 text.txt 全部转成小写', files: { 'text.txt': 'HELLO WORLD' }, expected: 'hello world' },
  { id: 'reverse-word', prompt: '将 text.txt 的字符顺序反转', files: { 'text.txt': 'gravitas' }, expected: 'sativarg' },
  { id: 'line-count', numeric: true, prompt: '计算 text.txt 的非空行数', files: { 'text.txt': 'one\n\ntwo\nthree\n' }, expected: '3' },
  { id: 'lookup-key', prompt: '读取 config.json 的 nested.region', files: { 'config.json': '{"nested":{"region":"ap-south"}}' }, expected: 'ap-south' },
  { id: 'ini-port', prompt: '读取 config.ini 的 port 值', files: { 'config.ini': '[server]\nhost=localhost\nport=8123\n' }, expected: '8123' },
  { id: 'markdown-heading', prompt: '读取 note.md 的二级标题文字，不含井号', files: { 'note.md': '# Main\n## Next Steps\nbody' }, expected: 'Next Steps' },
  { id: 'log-errors', numeric: true, prompt: '统计 app.log 中 ERROR 行数', files: { 'app.log': 'INFO start\nERROR x\nWARN y\nERROR z' }, expected: '2' },
  { id: 'intersection', prompt: '求 a.txt 和 b.txt 的整数交集，升序英文逗号连接无空格', files: { 'a.txt': '1 2 3 7', 'b.txt': '2 3 8' }, expected: '2,3' },
  { id: 'difference', prompt: '求 a.txt 中存在但 b.txt 中不存在的整数，升序英文逗号连接无空格', files: { 'a.txt': '1 2 3 7', 'b.txt': '2 3 8' }, expected: '1,7' },
  { id: 'json-names', prompt: '从 users.json 提取 role=admin 的 name，英文逗号连接无空格', files: { 'users.json': '[{"name":"Ada","role":"admin"},{"name":"Bob","role":"user"},{"name":"Carol","role":"admin"}]' }, expected: 'Ada,Carol' },
  { id: 'unicode-read', prompt: '读取 note.txt 中代号的值', files: { 'note.txt': '代号：青山-八号' }, expected: '青山-八号' },
  { id: 'decimal-sum', numeric: true, prompt: '求 a.txt 和 b.txt 两个十进制数之和', files: { 'a.txt': '0.25', 'b.txt': '0.75' }, expected: '1' },
]
CASES.push(...TRANSFORMS.map((c): PilotCase => ({
  id: c.id, files: c.files, requiredTools: ['Read', 'Write'],
  prompt: `${c.prompt}。先用 Read 读取输入，再将结果写入 answer.txt，只写结果，不含解释。`,
  verify: (dir) => ({ pass: c.numeric ? matchesNumericAnswer(fileText(dir, 'answer.txt'), Number(c.expected)) : fileText(dir, 'answer.txt').trim() === c.expected, detail: fileText(dir, 'answer.txt').trim() }),
})))

/** 跨会话冲突用例的两个互斥负载：多行内容，任何交错都会同时含两侧标记而被检出。 */
const CONFLICT_PAYLOAD_A = 'PAYLOAD-ALPHA\nalpha-line-1\nalpha-line-2\n'
const CONFLICT_PAYLOAD_B = 'PAYLOAD-BETA\nbeta-line-1\nbeta-line-2\n'

function collectEvidence(messages: SDKMessage[]): RunEvidence {
  const evidence: RunEvidence = { text: '', toolCalls: [], toolErrors: 0, permissionDecisions: [], requests: 0, inputTokens: 0, outputTokens: 0, errorTexts: [], toolErrorTexts: [] }
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>
    // 流式 partial 与最终消息内容重复：只统计 final，避免文本与工具调用被重复计数。
    if (record._partial === true) continue
    if (message.type === 'assistant') {
      const inner = record.message as { content?: Array<Record<string, unknown>>; usage?: { input_tokens?: number; output_tokens?: number } }
      evidence.requests += 1
      const errorField = record.error as { message?: unknown } | undefined
      if (errorField && typeof errorField.message === 'string') evidence.errorTexts.push(errorField.message.slice(0, 160))
      evidence.inputTokens += inner.usage?.input_tokens ?? 0
      evidence.outputTokens += inner.usage?.output_tokens ?? 0
      const stepText = (inner?.content ?? []).map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
      if (stepText.trim()) evidence.text = stepText
      for (const block of inner?.content ?? []) {
        if (block.type === 'tool_use') evidence.toolCalls.push({ name: String(block.name) })
      }
    }
    if (message.type === 'user') {
      const inner = record.message as { content?: Array<Record<string, unknown>> }
      for (const block of inner?.content ?? []) {
        if (block.type === 'tool_result' && block.is_error) {
          evidence.toolErrors += 1
          const content = block.content
          const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as Array<Record<string, unknown>>).map((c) => (typeof c.text === 'string' ? c.text : '')).join('') : ''
          if (text) evidence.toolErrorTexts.push(text)
        }
      }
    }
  }
  return evidence
}

type Arm = 'upgrade-scheduled' | 'baseline-serial'

interface RunRecord {
  arm: Arm
  caseId: string
  status: 'completed' | 'failed' | 'skipped_budget'
  pass: boolean
  detail: string
  requiredTools: string[]
  toolCallNames: string[]
  inputTokens: number
  outputTokens: number
  /** glm-5.3-flash 无可靠本地价格表：费用恒为 unknown，不估算、不记 0。 */
  cost: 'unknown'
  durationMs: number
  diagnostics?: GlmRunDiagnostics
  writerDiagnostics?: { a: GlmRunDiagnostics; b: GlmRunDiagnostics }
  error?: string
}

const RESULT_DIR = process.env.PROMA_PI_PILOT_OUT ?? join(tmpdir(), 'proma-glm-r01-results')
const REPORT_PATH = join(RESULT_DIR, 'report.json')
const MAX_RUNS = Number(process.env.PROMA_PI_PILOT_MAX_RUNS ?? '64')
const MODEL = (process.env.PROMA_PI_PILOT_MODEL ?? 'glm-5.3-flash').trim()
/** 只运行指定用例（逗号分隔）；conflict-cross-session 可单独重跑。 */
const ONLY = new Set((process.env.PROMA_PI_PILOT_ONLY ?? '').split(',').map((c) => c.trim()).filter(Boolean))
const EXCLUDE = new Set((process.env.PROMA_PI_PILOT_EXCLUDE ?? '').split(',').filter(Boolean))
const selectedCases = CASES.filter((c) => (ONLY.size === 0 || ONLY.has(c.id)) && !EXCLUDE.has(c.id))
const runConflict = ONLY.has('conflict-cross-session')
const priorBudgetPath = process.env.PROMA_PI_PILOT_PRIOR_BUDGET
const priorBudget: { reservedCny?: number } = priorBudgetPath ? JSON.parse(readFileSync(priorBudgetPath, 'utf8')) : {}
if (priorBudgetPath && typeof priorBudget.reservedCny !== 'number') throw new Error('历史预算文件缺少预留金额')
const budget = new GlmR01Budget(Number(process.env.PROMA_PI_PILOT_CAP_CNY ?? '10'), priorBudget.reservedCny ?? 0)
let benchmarkBaseUrl = ''
let gateway: ReturnType<typeof Bun.serve> | undefined

const workRoots: string[] = []
afterAll(() => {
  // 恢复调度器默认启用状态，避免影响同进程其他测试。
  setToolSchedulerDisabled(false)
  gateway?.stop(true)
  closeProjectDb()
  for (const dir of workRoots) rmSync(dir, { recursive: true, force: true })
  rmSync(tempConfigDir, { recursive: true, force: true })
})

async function runCase(adapter: InstanceType<typeof PiAgentAdapter>, apiKey: string, pilotCase: PilotCase, arm: Arm): Promise<{ record: Omit<RunRecord, 'durationMs' | 'status'> & { error?: string }; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), `glm-r01-${pilotCase.id}-`))
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
    const queryInput: PilotQueryOptions = {
      sessionId: `glm-r01-${arm}-${pilotCase.id}-${Date.now()}`,
      prompt: pilotCase.prompt,
      agentRuntime: 'pi',
      provider: 'zhipu',
      apiKey,
      baseUrl: benchmarkBaseUrl,
      model: MODEL,
      cwd: dir,
      permissionMode: 'bypassPermissions',
      canUseTool: async (name, args) => {
        const rawPath = typeof args.file_path === 'string' ? args.file_path : ''
        const target = resolve(dir, rawPath)
        const inDir = target.startsWith(`${dir}/`)
        const fileAllowed = ['Read', 'Write', 'Edit'].includes(name) && inDir
        const grepAllowed = name === 'Grep' && (!args.path || (typeof args.path === 'string' && (resolve(dir, args.path) === dir || resolve(dir, args.path).startsWith(`${dir}/`))))
        const bashAllowed = name === 'Bash' && pilotCase.id === 'bash-list' && typeof args.command === 'string' && /^ls(?: -[a-zA-Z]+)?(?: \.)?$/.test(args.command.trim())
        const allowed = (fileAllowed || grepAllowed || bashAllowed) && (!pilotCase.denyWrites || name === 'Read')
        permissionDecisions.push({ name, allowed })
        return allowed ? { allowed: true } : { allowed: false, message: '试点策略拒绝写入类工具' }
      },
    }
    for await (const message of adapter.query(queryInput)) messages.push(message)
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, 300) : String(caught).slice(0, 300)
  }
  const evidence = collectEvidence(messages)
  if (!error && evidence.errorTexts.length) error = evidence.errorTexts.join('; ').slice(0, 300)
  evidence.permissionDecisions = permissionDecisions
  let verdict = { pass: false, detail: error ?? '未核验' }
  if (!error) {
    try { verdict = pilotCase.verify(dir, evidence) } catch (caught) { verdict = { pass: false, detail: `核验异常：${String(caught).slice(0, 120)}` } }
  }
  return {
    dir,
    record: {
      arm, caseId: pilotCase.id, pass: verdict.pass, detail: verdict.detail,
      requiredTools: pilotCase.requiredTools, toolCallNames: evidence.toolCalls.map((c) => c.name),
      inputTokens: evidence.inputTokens, outputTokens: evidence.outputTokens, cost: 'unknown', error, diagnostics: captureRunDiagnostics(evidence),
    },
  }
}

;(enabled ? describe : describe.skip)('R01 GLM-5.3-Flash 真实配对试点', () => {
  test('30个任务配对，HTTP请求前预留人民币预算', async () => {
    mkdirSync(RESULT_DIR, { recursive: true })
    const budgetFile = join(RESULT_DIR, 'budget-reservations.json')
    if (existsSync(budgetFile)) throw new Error('该输出目录已有费用预留记录，拒绝重跑以避免重复消费；请先核对既有报告')
    // 项目库只在临时配置目录内初始化，不触碰真实 ~/.gravitas 数据。
    await initProjectDb()
    const adapter = new PiAgentAdapter()
    const apiKey = process.env.PROMA_PI_PILOT_GLM_KEY ?? ''
    if (MODEL !== 'glm-5.3-flash') throw new Error('本预算仅授权glm-5.3-flash')
    const persistBudget = (): void => writeFileSync(budgetFile, JSON.stringify({ capCny: budget.capCny, reservedCny: budget.reservedCny, requests: budget.requests, confirmedEstimateCny: budget.confirmedEstimateCny }))
    const upstreamFetch = getFetchFn(process.env.PROMA_PI_PILOT_PROXY ?? await getEffectiveProxyUrl())
    gateway = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        if (request.method !== 'POST' || new URL(request.url).pathname !== '/chat/completions'
          || request.headers.get('authorization') !== `Bearer ${apiKey}`) return new Response('不支持的试点请求', { status: 403 })
        let bodyBytes = 0
        let phase = 'parse'
        try {
          const body = await request.json() as Record<string, unknown>
          if (body.model !== MODEL) return new Response('未授权模型', { status: 403 })
          // 对每次HTTP重试重新预留；预留器同步操作，跨会话不能同时超订。
          const serialized = JSON.stringify(normalizeGlmR01Request(body, budget.maxOutputTokens))
          bodyBytes = Buffer.byteLength(serialized, 'utf8')
          phase = 'reservation'
          const receipt = budget.reserve(bodyBytes)
          // 请求前持久化；崩溃或响应缺usage也不把费用重新归零。
          persistBudget()
          phase = 'upstream'
          const offlineProbe = process.env.PROMA_PI_PILOT_OFFLINE_PROBE === '1'
          // 模拟仅用于本地协议/预算流水验证，绝不计为真实Provider样本。
          const mockChunk = { id: 'offline', object: 'chat.completion.chunk', created: 0, model: MODEL }
          const mockSse = [
            { ...mockChunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
            { ...mockChunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            { ...mockChunk, choices: [], usage: { prompt_tokens: 7000, completion_tokens: 50, total_tokens: 7050 } },
          ].map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
          const response = offlineProbe
            ? new Response(mockSse, { headers: { 'content-type': 'text/event-stream' } })
            : await upstreamFetch(`${PROVIDER_DEFAULT_URLS.zhipu}/chat/completions`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: serialized, signal: AbortSignal.timeout(90_000),
          })
          if (!response.ok || !response.body) return response
          const headers = new Headers(response.headers)
          headers.delete('content-length')
          headers.delete('content-encoding')
          const stream = response.body.pipeThrough(observeGlmR01Usage((prompt, completion) => {
            budget.settle(receipt, prompt, completion)
            persistBudget()
          }))
          return new Response(stream, { status: response.status, headers })
        } catch {
          // 只暴露本地阶段和字节计数，不回传Provider异常、headers或凭据。
          return Response.json({ error: { message: `试点拒绝: phase=${phase}; bodyBytes=${bodyBytes}` } }, { status: 400 })
        }
      },
    })
    benchmarkBaseUrl = `http://127.0.0.1:${gateway.port}`
    const records: RunRecord[] = []
    const save = (summary?: Record<string, unknown>): void => writeFileSync(REPORT_PATH, JSON.stringify({
      model: MODEL, executionSource: process.env.PROMA_PI_PILOT_OFFLINE_PROBE === '1' ? 'offline_stub' : 'real_provider', maxRuns: MAX_RUNS, runCount, budget: { capCny: budget.capCny, reservedCny: budget.reservedCny,
        requests: budget.requests, confirmedEstimateCny: budget.confirmedEstimateCny, costSource: 'conservative_local_reservation', actualCost: 'unknown', priceSource: 'https://bigmodel.cn/pricing', priceAsOf: '2026-10-10' }, summary, records,
    }, null, 2))
    let runCount = 0
    let stoppedAfterError = false

    const arms: Arm[] = ['upgrade-scheduled', 'baseline-serial']
    for (const arm of arms) {
      // 基线臂=禁用调度器（退化为全串行持锁，E04 语义）；升级臂=启用。
      setToolSchedulerDisabled(arm === 'baseline-serial')
      for (const pilotCase of selectedCases) {
        if (stoppedAfterError || runCount >= MAX_RUNS) {
          records.push({ arm, caseId: pilotCase.id, status: 'skipped_budget', pass: false, detail: stoppedAfterError ? '前序请求失败，停止本批以避免重复费用' : '达到运行次数上限，未运行', requiredTools: pilotCase.requiredTools, toolCallNames: [], inputTokens: 0, outputTokens: 0, cost: 'unknown', durationMs: 0 })
          continue
        }
        const started = Date.now()
        const { record } = await runCase(adapter, apiKey, pilotCase, arm)
        runCount += 1
        if (record.error && process.env.PROMA_PI_PILOT_OFFLINE_PROBE !== '1') stoppedAfterError = true
        records.push({ ...record, status: record.error ? 'failed' : 'completed', durationMs: Date.now() - started })
        save()
      }
    }

    // 跨会话同文件冲突：两臂各一次；两个并发会话整体覆盖同一文件，最终内容必须恰等于某一侧负载。
    if (runConflict) for (const arm of arms) {
      if (runCount + 2 > MAX_RUNS) break
      runCount += 2
      setToolSchedulerDisabled(arm === 'baseline-serial')
      const sharedDir = mkdtempSync(join(tmpdir(), `glm-r01-conflict-${arm}-`))
      workRoots.push(sharedDir)
      writeFileSync(join(sharedDir, 'shared.txt'), 'INITIAL\n')
      // shared.txt 已存在，Write 需先读：提示词显式要求先 Read，贴近真实跨会话改写场景。
      const makeWriter = (payload: string, tag: string): PilotQueryOptions => ({
        sessionId: `glm-r01-conflict-${arm}-${tag}-${Date.now()}`,
        prompt: `先用 Read 读取 shared.txt，然后用 Write 把它的内容整体覆盖为以下内容（逐字，不含本说明）：\n${payload}\n完成后只回复 DONE。`,
        agentRuntime: 'pi', provider: 'zhipu', apiKey, baseUrl: benchmarkBaseUrl,
        model: MODEL, cwd: sharedDir, permissionMode: 'bypassPermissions',
        // 与普通用例一样必须显式提供权限回调；bypassPermissions 不替代工具桥回调。
        // 冲突场景只授权本次临时 shared.txt 的读取和覆盖，不开放 Bash 或其他路径。
        canUseTool: async (name, args) => {
          const path = typeof args.file_path === 'string' ? args.file_path : ''
          const allowed = ['Read', 'Write'].includes(name)
            && ['shared.txt', './shared.txt', join(sharedDir, 'shared.txt')].includes(path)
          return allowed ? { allowed: true } : { allowed: false, message: '冲突试点仅授权临时 shared.txt 的 Read/Write' }
        },
      })
      const started = Date.now()
      let conflictError: string | undefined
      let evA: RunEvidence = { text: '', toolCalls: [], toolErrors: 0, permissionDecisions: [], requests: 0, inputTokens: 0, outputTokens: 0, errorTexts: [], toolErrorTexts: [] }
      let evB: RunEvidence = { ...evA, toolCalls: [], permissionDecisions: [], errorTexts: [], toolErrorTexts: [] }
      try {
        const [messagesA, messagesB] = await Promise.all([
          (async () => { const ms: SDKMessage[] = []; for await (const m of adapter.query(makeWriter(CONFLICT_PAYLOAD_A, 'a'))) ms.push(m); return ms })(),
          (async () => { const ms: SDKMessage[] = []; for await (const m of adapter.query(makeWriter(CONFLICT_PAYLOAD_B, 'b'))) ms.push(m); return ms })(),
        ])
        evA = collectEvidence(messagesA)
        evB = collectEvidence(messagesB)
      } catch (caught) {
        conflictError = caught instanceof Error ? caught.message.slice(0, 300) : String(caught).slice(0, 300)
      }
      const finalText = fileText(sharedDir, 'shared.txt')
      const isA = finalText.trim() === CONFLICT_PAYLOAD_A.trim()
      const isB = finalText.trim() === CONFLICT_PAYLOAD_B.trim()
      const interleaved = !isA && !isB && finalText.includes('PAYLOAD-ALPHA') && finalText.includes('PAYLOAD-BETA')
      const writerErr = (ev: RunEvidence): string => (ev.toolErrorTexts.length ? ` 工具错误:${ev.toolErrorTexts[0]!.slice(0, 100)}` : '') + (ev.errorTexts.length ? ` 消息错误:${ev.errorTexts[0]!.slice(0, 60)}` : '')
      const writerSummary = `A[${evA.toolCalls.map((c) => c.name).join('/') || '无工具'}${writerErr(evA)}] B[${evB.toolCalls.map((c) => c.name).join('/') || '无工具'}${writerErr(evB)}]`
      records.push({
        arm, caseId: 'conflict-cross-session', status: conflictError ? 'failed' : 'completed',
        pass: !conflictError && (isA || isB) && !interleaved,
        detail: conflictError ?? `最终内容=${isA ? 'A侧' : isB ? 'B侧' : interleaved ? '交错损坏' : `其他: ${JSON.stringify(finalText.slice(0, 160))}`} | ${writerSummary}`,
        requiredTools: ['Write'],
        toolCallNames: [...evA.toolCalls.map((c) => `A:${c.name}`), ...evB.toolCalls.map((c) => `B:${c.name}`)],
        inputTokens: evA.inputTokens + evB.inputTokens, outputTokens: evA.outputTokens + evB.outputTokens, cost: 'unknown',
        durationMs: Date.now() - started, error: conflictError, writerDiagnostics: { a: captureRunDiagnostics(evA), b: captureRunDiagnostics(evB) },
      })
      save()
    }
    setToolSchedulerDisabled(false)

    const completed = records.filter((r) => r.status === 'completed')
    const metrics = schedulerMetricsSnapshot()
    save({
        completedPairs: selectedCases.filter((c) => arms.every((arm) => records.some((r) => r.arm === arm && r.caseId === c.id && r.status === 'completed'))).length,
        passedPairs: selectedCases.filter((c) => arms.every((arm) => records.some((r) => r.arm === arm && r.caseId === c.id && r.pass))).length,
        total: records.length, completed: completed.length,
        passed: completed.filter((r) => r.pass).length,
        byArm: arms.map((arm) => {
          const armRuns = completed.filter((r) => r.arm === arm)
          const requiredHit = armRuns.filter((r) => r.requiredTools.length > 0 && r.requiredTools.every((t) => r.toolCallNames.some((name) => name === t || name === `A:${t}` || name === `B:${t}`))).length
          const requiredTotal = armRuns.filter((r) => r.requiredTools.length > 0).length
          return { arm, runs: armRuns.length, passed: armRuns.filter((r) => r.pass).length, requiredToolRecall: requiredTotal === 0 ? null : `${requiredHit}/${requiredTotal}` }
        }),
        schedulerMetrics: metrics,
        note: '基线为当前构建全串行模式，非历史版本；30固定任务仅作筛查。预留额是本地估计，非Provider实际账单。',
    })
    // 试点只记录事实，不以“全部通过”作为门禁；结果由报告解读。
    expect(records.length).toBeGreaterThan(0)
    // 报告写完不代表调用成功：运行时/请求边界失败必须在终端显示失败。
    if (process.env.PROMA_PI_PILOT_OFFLINE_PROBE !== '1') {
      expect(records.filter((r) => r.status === 'failed').length).toBe(0)
      expect(records.filter((r) => r.status === 'skipped_budget').length).toBe(0)
    }
  }, 3_600_000)
})
