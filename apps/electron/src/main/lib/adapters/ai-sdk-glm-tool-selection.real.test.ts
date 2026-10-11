/**
 * D04 真实工具选择评测（ai-sdk runtime × glm-5.3-flash，配对双臂筛查）。
 *
 * 默认跳过。需 PROMA_TOOL_EVAL=1 与 PROMA_PI_PILOT_GLM_KEY（与 R01 试点同变量）。
 * 授权：沿用 2026-10-10 用户人民币10元总额度；本评测从既有预算账本续算，
 * 超过剩余额度（10 − 已预留）即停止。费用为本地标准价估计，非 Provider 账单。
 *
 * 配对设计：同一任务两臂各跑一次——
 * - baseline：全量工具 schema 进模型（既有行为）；
 * - loading：D03 toolLoading 小预算（模型只看到选中能力的摘要+schema）。
 * 独立核验任务成功与 required-tool recall，比较小样本非劣（筛查，不宣称统计充分）。
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROVIDER_DEFAULT_URLS } from '@gravitas/shared'
import { buildElectronMock } from '../testing/electron-mock'

const enabled = process.env.PROMA_TOOL_EVAL === '1' && Boolean(process.env.PROMA_PI_PILOT_GLM_KEY)
const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const testDir = mkdtempSync(join(tmpdir(), 'gravitas-tool-eval-config-'))
process.env.PROMA_TEST_CONFIG_DIR = testDir

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

const { AISDKAgentAdapter } = await import('./ai-sdk-agent-adapter')
const { createCoreTools, GOAL_CHECKPOINT_TOOL_NAME } = await import('../agent-runtime/tool-registry')
const { buildToolCapabilityCatalog } = await import('../agent-runtime/tool-capability-catalog')
const { closeProjectDb, initProjectDb } = await import('../project-sqlite-store')

const MODEL = (process.env.PROMA_PI_PILOT_MODEL ?? 'glm-5.3-flash').trim()
const OUT_DIR = process.env.PROMA_TOOL_EVAL_OUT ?? join(tmpdir(), 'gravitas-tool-eval-results')
/** 双臂 × 任务数上限；费用熔断以更严格的剩余预算为准。 */
const MAX_RUNS = Number(process.env.PROMA_TOOL_EVAL_MAX_RUNS ?? '20')
/** loading 臂摘要预算：只容少量能力摘要，考察发现质量。 */
const LOADING_BUDGET = Number(process.env.PROMA_TOOL_EVAL_LOADING_BUDGET ?? '130')

/** 智谱标准价（元/百万token），同 R01 试点口径；忽略缓存折扣。 */
const PRICE = { input: 0.8, output: 2.8 }

interface EvalTask {
  id: string
  prompt: string
  files: Record<string, string>
  requiredTools: string[]
  verify: (dir: string, toolNames: string[], finalText: string) => { pass: boolean; detail: string }
}

const TASKS: EvalTask[] = [
  { id: 'read-secret', prompt: '读取 notes.txt，只回复其中 code 的值。', files: { 'notes.txt': 'code: VIOLET-2210\n' }, requiredTools: ['Read'],
    verify: (_d, tools, text) => ({ pass: text.includes('VIOLET-2210') && tools.includes('Read'), detail: `Read+值=${text.slice(0, 40)}` }) },
  { id: 'write-file', prompt: '创建 out.txt，内容为一行 SNAP-OK。', files: {}, requiredTools: ['Write'],
    verify: (dir, tools) => {
      const content = existsSync(join(dir, 'out.txt')) ? readFileSync(join(dir, 'out.txt'), 'utf8') : ''
      return { pass: content.includes('SNAP-OK') && tools.includes('Write'), detail: content.trim() }
    } },
  { id: 'grep-find', prompt: '在当前目录的 .ts 文件里找出定义函数 buildConfig 的文件名，只回复文件名。', files: { 'a.ts': 'export function buildConfig() { return 1 }\n', 'b.ts': 'export const x = 1\n' }, requiredTools: ['Grep'],
    verify: (_d, tools, text) => ({ pass: /a\.ts/.test(text) && tools.includes('Grep'), detail: text.slice(0, 40) }) },
  { id: 'bash-list', prompt: '用 Bash 列出当前目录全部文件名，用英文逗号分隔回复。', files: { 'x1.txt': '1', 'x2.txt': '2' }, requiredTools: ['Bash'],
    verify: (_d, tools, text) => ({ pass: text.includes('x1.txt') && text.includes('x2.txt') && tools.includes('Bash'), detail: text.slice(0, 60) }) },
  { id: 'edit-constant', prompt: '把 config.ts 里的 LIMIT 从 3 改为 7。', files: { 'config.ts': 'export const LIMIT = 3\n' }, requiredTools: ['Edit'],
    verify: (dir, tools) => {
      const content = readFileSync(join(dir, 'config.ts'), 'utf8')
      return { pass: content.includes('LIMIT = 7') && !content.includes('LIMIT = 3') && tools.includes('Edit'), detail: content.trim() }
    } },
  { id: 'read-sum-write', prompt: '读取 a.txt 与 b.txt（各一个整数），把和写入 total.txt，只写数字。', files: { 'a.txt': '31\n', 'b.txt': '11\n' }, requiredTools: ['Read', 'Write'],
    verify: (dir, tools) => {
      const content = existsSync(join(dir, 'total.txt')) ? readFileSync(join(dir, 'total.txt'), 'utf8').trim() : ''
      return { pass: content === '42' && tools.includes('Read') && tools.includes('Write'), detail: content }
    } },
  { id: 'grep-then-read', prompt: '先找出包含 NEEDLE 的文件名，再读取该文件第一行并用逗号分隔回复文件名与内容。', files: { 'deep/hay.txt': 'NEEDLE-POINT\nsecond line\n', 'other.txt': 'nothing\n' }, requiredTools: ['Grep', 'Read'],
    verify: (_d, tools, text) => ({ pass: text.includes('hay.txt') && text.includes('NEEDLE-POINT') && tools.includes('Grep') && tools.includes('Read'), detail: text.slice(0, 60) }) },
]

const workRoots: string[] = []
beforeAll(async () => { await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  for (const dir of workRoots) rmSync(dir, { recursive: true, force: true })
  rmSync(testDir, { recursive: true, force: true })
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
})

;(enabled ? describe : describe.skip)('D04 真实工具选择评测（ai-sdk × glm-5.3-flash）', () => {
  test('配对双臂：baseline 全量 vs loading 摘要预算；独立核验并费用熔断', async () => {
    mkdirSync(OUT_DIR, { recursive: true })
    const apiKey = process.env.PROMA_PI_PILOT_GLM_KEY ?? ''
    // 既有预算账本续算（R01 试点链最新节点）。
    const priorPath = process.env.PROMA_TOOL_EVAL_PRIOR_BUDGET ?? ''
    const priorReserved = priorPath && existsSync(priorPath)
      ? (JSON.parse(readFileSync(priorPath, 'utf8')) as { reservedCny?: number }).reservedCny ?? 0
      : 0
    if (MODEL !== 'glm-5.3-flash') throw new Error('本评测仅授权 glm-5.3-flash')
    const budgetRemaining = Math.max(0, 10 - priorReserved)
    if (budgetRemaining < 0.5) throw new Error(`剩余额度不足：¥${budgetRemaining.toFixed(3)}`)

    const catalog = buildToolCapabilityCatalog(
      createCoreTools().filter((tool) => tool.name !== GOAL_CHECKPOINT_TOOL_NAME),
    ).catalog
    const arms = ['baseline', 'loading'] as const
    const records: Array<Record<string, unknown>> = []
    let estimatedCny = 0
    let inputTokens = 0
    let outputTokens = 0
    let runCount = 0
    let stoppedByBudget = false

    const estimate = (input: number, output: number): number => (input * PRICE.input + output * PRICE.output) / 1_000_000

    for (const arm of arms) {
      for (const task of TASKS) {
        if (runCount >= MAX_RUNS || estimatedCny + 0.06 > budgetRemaining) {
          stoppedByBudget = true
          break
        }
        const dir = mkdtempSync(join(tmpdir(), `tool-eval-${arm}-${task.id}-`))
        workRoots.push(dir)
        for (const [file, content] of Object.entries(task.files)) {
          const target = join(dir, file)
          mkdirSync(join(target, '..'), { recursive: true })
          writeFileSync(target, content)
        }
        const messages = []
        const toolNames: string[] = []
        let error: string | undefined
        const started = Date.now()
        try {
          const adapter = new AISDKAgentAdapter()
          for await (const message of adapter.query({
            sessionId: `tool-eval-${arm}-${task.id}-${Date.now()}`,
            prompt: task.prompt,
            agentRuntime: 'ai-sdk',
            provider: 'zhipu',
            apiKey,
            baseUrl: PROVIDER_DEFAULT_URLS.zhipu,
            model: MODEL,
            cwd: dir,
            permissionMode: 'bypassPermissions',
            maxTurns: 4,
            maxRetries: 0,
            canUseTool: async (name: string) => (['Read', 'Write', 'Edit', 'Grep', 'Bash'].includes(name)
              ? { allowed: true }
              : { allowed: false, message: '评测仅授权文件与 shell 工具' }),
            ...(arm === 'loading'
              ? { toolLoading: { catalog, query: task.prompt, tokenBudget: LOADING_BUDGET } }
              : {}),
          } as never)) {
            messages.push(message)
            if (message.type === 'assistant') {
              const content = (message as unknown as { message?: { content?: Array<{ type: string; name?: string }> } }).message?.content ?? []
              for (const block of content) if (block.type === 'tool_use' && block.name) toolNames.push(block.name)
            }
          }
        } catch (caught) {
          error = caught instanceof Error ? caught.message.slice(0, 300) : String(caught).slice(0, 300)
        }
        let finalText = ''
        let usage: { input?: number; output?: number } = {}
        for (const message of messages) {
          const record = message as unknown as Record<string, unknown>
          if (record._partial === true) continue
          if (message.type === 'result') {
            // 权威 usage 在 result 消息（ai-sdk 汇总）；assistant 消息可能缺失。
            const resultUsage = (record as unknown as { usage?: { input_tokens?: number; output_tokens?: number } }).usage
            if (resultUsage) usage = { input: resultUsage.input_tokens, output: resultUsage.output_tokens }
            continue
          }
          if (message.type === 'assistant') {
            const inner = record.message as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } }
            const text = (inner.content ?? []).map((block) => (block.type === 'text' ? block.text ?? '' : '')).join('')
            if (text.trim()) finalText = text
          }
        }
        inputTokens += usage.input ?? 0
        outputTokens += usage.output ?? 0
        const runCost = estimate(usage.input ?? 0, usage.output ?? 0)
        estimatedCny += runCost
        runCount += 1
        const verdict = error ? { pass: false, detail: error } : task.verify(dir, toolNames, finalText)
        records.push({
          arm, taskId: task.id, pass: verdict.pass, detail: verdict.detail, error,
          requiredRecall: task.requiredTools.every((tool) => toolNames.includes(tool)),
          toolNames: [...new Set(toolNames)], durationMs: Date.now() - started,
          inputTokens: usage.input ?? 0, outputTokens: usage.output ?? 0, estimatedCny: runCost,
        })
        writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify({
          model: MODEL, arms, loadingBudget: LOADING_BUDGET, runCount,
          priorReservedCny: priorReserved, estimatedCnyTotal: estimatedCny,
          inputTokens, outputTokens, stoppedByBudget,
          costNote: '本地标准价估计，非Provider账单；usage缺失的运行不计费估计',
          records,
        }, null, 2))
      }
    }

    const byArm = (arm: string) => records.filter((record) => record.arm === arm)
    const summary = {
      baseline: { runs: byArm('baseline').length, passed: byArm('baseline').filter((r) => r.pass).length, recall: byArm('baseline').filter((r) => r.requiredRecall).length },
      loading: { runs: byArm('loading').length, passed: byArm('loading').filter((r) => r.pass).length, recall: byArm('loading').filter((r) => r.requiredRecall).length },
      estimatedCnyTotal: estimatedCny,
      stoppedByBudget,
      note: '小样本配对筛查，不宣称统计非劣；usage缺失记0不影响pass判定但计入成本保守',
    }
    writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify({
      model: MODEL, arms, loadingBudget: LOADING_BUDGET, runCount,
      priorReservedCny: priorReserved, estimatedCnyTotal: estimatedCny,
      inputTokens, outputTokens, stoppedByBudget, summary,
      costNote: '本地标准价估计，非Provider账单',
      records,
    }, null, 2))
    // 只记录事实，不以全部通过为门禁。
    expect(records.length).toBeGreaterThan(0)
    expect(estimatedCny).toBeLessThanOrEqual(budgetRemaining)
  }, 1_800_000)
})
