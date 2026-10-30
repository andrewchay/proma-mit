import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PROJECT_IPC_CHANNELS } from '@gravitas/shared'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { buildElectronMock } from '../../../main/lib/testing/electron-mock'

// 两个定稿真实案例（见会话工作台 owner-test-cases.md）的隔离连续旅程：
// 场景1 网页版2048（研发代码交付物）；场景2 FDE落地要点（PDF资料分析交付物）。
// 全程隔离 SQLite 与 fake Runner/transport，不发送真实 Provider 请求。
const directory = mkdtempSync(join(tmpdir(), 'owner-real-case-journey-'))
const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('../../../main/lib/agent-service', () => ({ isAgentSessionActive: () => false }))

const database = await import('../../../main/lib/project-sqlite-store')
const employees = await import('../../../main/lib/agent-employee-service')
const controlledTasks = await import('../../../main/lib/controlled-project-task-service')
const { createAgentWorkspace, getAgentWorkspace, getAgentWorkspaceCwd, listAgentWorkspaces } = await import('../../../main/lib/agent-workspace-manager')
const { createChannel, listChannels } = await import('../../../main/lib/channel-manager')
const { bindWorkspaceToProject, listProjectWorkspaceBindings } = await import('../../../main/lib/project-workspace-bindings')
const { createProject } = await import('../../../main/lib/project-sqlite-store')
const { getOwnerManagementConversation } = await import('../../../main/lib/project-owner-management-questions')
const { startOwnerManagementLoop } = await import('../../../main/lib/project-owner-management-loop')
const { getProjectOwnerPlanDraft } = await import('../../../main/lib/project-owner-plan-service')
const { saveProjectOwnerGoalDraft } = await import('../../../main/lib/project-owner-goal-service')
const { saveOwnerRuntimeBinding } = await import('../../../main/lib/project-owner-runtime-binding')
const managementDelegation = await import('../../../main/lib/project-owner-management-delegation')
const knowledgeCatalog = await import('../../../main/lib/knowledge-catalog-service')
const { setHeadlessAgentRunner } = await import('../../../main/lib/agent-headless-runner-registry')
const { resolveOwnerPlanningSession } = await import('../../../main/lib/project-owner-planning-source')
const { claimOwnerPlanningProviderRequest } = await import('../../../main/lib/project-owner-planning-provider')
const { registerProjectOwnerGoalIpcHandlers } = await import('../../../main/lib/project-owner-goal-ipc')
const { registerProjectOwnerPlanIpcHandlers } = await import('../../../main/lib/project-owner-plan-ipc')
const { registerProjectOwnerRuntimeIpcHandlers } = await import('../../../main/lib/project-owner-runtime-ipc')
const { registerProjectOwnerExecutionIpcHandlers } = await import('../../../main/lib/project-owner-execution-ipc')
const { registerProjectOwnerExecutionGrantIpcHandlers } = await import('../../../main/lib/project-owner-execution-grant-ipc')
const { registerProjectOwnerExecutionRevalidationIpcHandlers } = await import('../../../main/lib/project-owner-execution-revalidation-ipc')
const { registerProjectOwnerTaskIpcHandlers } = await import('../../../main/lib/project-owner-task-ipc')

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip
let journeyBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const ipcHandlers = new Map<string, (event: unknown, request: unknown) => unknown>()
const register = { handle: (channel: string, handler: (event: unknown, request: unknown) => unknown) => { ipcHandlers.set(channel, handler) } }
registerProjectOwnerGoalIpcHandlers(register)
registerProjectOwnerPlanIpcHandlers(register)
registerProjectOwnerRuntimeIpcHandlers(register)
registerProjectOwnerExecutionIpcHandlers(register)
registerProjectOwnerExecutionGrantIpcHandlers(register)
registerProjectOwnerExecutionRevalidationIpcHandlers(register)
registerProjectOwnerTaskIpcHandlers(register)

const calls: string[] = []
const employeeCalls: string[] = []
const bridgeCalls: string[] = []
/** 当前测试的调用窗口起点；fake Runner与断言都只看窗口内事件，跨测试后台残留不计入。 */
let windowStart = { calls: 0, employees: 0 }

/** 程序化生成最小有效 PDF（每页一行文本），供隔离资料源与引用完整性核对使用。 */
function buildTextPdf(pages: string[]): Buffer {
  const objects: string[] = []
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`
  pages.forEach((text, i) => {
    const contentId = 4 + i * 2
    const stream = `BT /F1 14 Tf 40 750 Td (${text.replace(/[\\()]/g, m => `\\${m}`)}) Tj ET`
    objects[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${4 + pages.length * 2} 0 R >> >> >>`
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  objects[4 + pages.length * 2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id++) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

/** 案例B的资料事实（页1/页2），fake 员工分析只允许引用这些事实。 */
const FDE_PDF_PAGES = [
  'MTX AI Playbook P1: S1 feeding error prevention and S2 batch traceability first. 4-week baseline before pilot.',
  'P2: 10-week pilot. Annual gross benefit 3.08M CNY, 2.58M after operations. Payback about 36 months. Milestone payment 3:4:2:1.',
]
const FDE_CITED_FACTS = ['S1 feeding error prevention', '4-week baseline', '10-week pilot', '3.08M', '2.58M', '36 months', '3:4:2:1', 'S2 batch traceability']

/** fake 员工交付的单文件网页2048（真实可运行的完整逻辑，作为文本成果）。 */
const GAME_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>2048</title>
<style>body{font-family:sans-serif;text-align:center;background:#faf8ef}#board{display:inline-grid;grid-template-columns:repeat(4,90px);gap:8px;background:#bbada0;padding:8px;border-radius:8px}.cell{width:90px;height:90px;border-radius:4px;background:rgba(238,228,218,.35);display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:700}</style>
</head>
<body>
<h1>2048</h1>
<p>得分：<span id="score">0</span>　最高分：<span id="best">0</span>　<button id="restart">重新开始</button></p>
<div id="board"></div>
<p id="status"></p>
<script>
'use strict'
const SIZE = 4
let board, score, over, won
const bestKey = 'game-2048-best'
function emptyBoard() { return Array.from({ length: SIZE }, () => Array(SIZE).fill(0)) }
function addRandomTile() {
  const free = []
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (!board[r][c]) free.push([r, c])
  if (!free.length) return
  const [r, c] = free[Math.floor(Math.random() * free.length)]
  board[r][c] = Math.random() < 0.9 ? 2 : 4
}
function slideRow(row) {
  const values = row.filter(v => v)
  let gained = 0
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i] === values[i + 1]) { values[i] *= 2; gained += values[i]; values.splice(i + 1, 1) }
  }
  while (values.length < SIZE) values.push(0)
  return { row: values, gained }
}
function move(direction) {
  if (over) return false
  const before = JSON.stringify(board)
  for (let i = 0; i < SIZE; i++) {
    let line = []
    for (let j = 0; j < SIZE; j++) {
      const r = direction === 'up' ? j : direction === 'down' ? SIZE - 1 - j : i
      const c = direction === 'left' ? j : direction === 'right' ? SIZE - 1 - j : i
      line.push(board[r][c])
    }
    const { row, gained } = slideRow(line)
    score += gained
    for (let j = 0; j < SIZE; j++) {
      const r = direction === 'up' ? j : direction === 'down' ? SIZE - 1 - j : i
      const c = direction === 'left' ? j : direction === 'right' ? SIZE - 1 - j : i
      board[r][c] = row[j]
    }
  }
  if (JSON.stringify(board) === before) return false
  addRandomTile()
  if (board.flat().includes(2048)) won = true
  if (!canMove()) over = true
  return true
}
function canMove() {
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    if (!board[r][c]) return true
    if (c + 1 < SIZE && board[r][c] === board[r][c + 1]) return true
    if (r + 1 < SIZE && board[r][c] === board[r + 1][c]) return true
  }
  return false
}
function render() {
  const boardEl = document.getElementById('board')
  boardEl.innerHTML = ''
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const cell = document.createElement('div')
    cell.className = 'cell'
    if (board[r][c]) cell.textContent = String(board[r][c])
    boardEl.appendChild(cell)
  }
  document.getElementById('score').textContent = String(score)
  const best = Math.max(Number(localStorage.getItem(bestKey) || 0), score)
  localStorage.setItem(bestKey, String(best))
  document.getElementById('best').textContent = String(best)
  document.getElementById('status').textContent = over ? '游戏结束' : won ? '达成2048，可继续游玩' : ''
}
function restart() {
  board = emptyBoard(); score = 0; over = false; won = false
  addRandomTile(); addRandomTile(); render()
}
document.addEventListener('keydown', event => {
  const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
  const direction = map[event.key]
  if (!direction) return
  event.preventDefault()
  if (move(direction)) render()
})
document.getElementById('restart').addEventListener('click', restart)
// 逻辑自测：单行合并、随机生成与判负
;(() => {
  const merged = slideRow([2, 2, 4, 4])
  console.assert(merged.row.join() === '4,8,0,0' && merged.gained === 12, '合并逻辑自测失败')
  board = emptyBoard(); addRandomTile()
  console.assert(board.flat().filter(Boolean).length === 1 && [2, 4].includes(board.flat().find(Boolean)), '随机生成自测失败')
  board = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]
  console.assert(!canMove(), '判负逻辑自测失败')
})()
restart()
</script>
</body>
</html>`

beforeAll(async () => {
  await database.initProjectDb()
  setHeadlessAgentRunner(async (input, handlers) => {
    const execution = database.getAgentExecutionBySessionId(input.sessionId)
    if (execution?.ownerCommandId) {
      handlers.onRuntimeStarted?.()
      const command = database.getProjectDb().prepare('SELECT role FROM project_owner_execution_commands WHERE id=?').get(execution.ownerCommandId) as { role: 'executor' | 'reviewer' }
      const task = database.getTask(execution.entityId)
      const workspace = task?.workspaceId ? getAgentWorkspace(task.workspaceId) : null
      if (!task || !workspace) throw new Error('fake Runner 找不到已派发员工的任务或工作区')
      employeeCalls.push(command.role)
      const transport = Object.assign(async () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }), { headers: { 'content-type': 'application/json' } }), { preconnect: () => {} }) as typeof globalThis.fetch
      const { createControlledProviderFetch } = await import('../../../main/lib/controlled-provider-boundary')
      const fetch = createControlledProviderFetch(input.sessionId, () => ({ runtime: 'ai-sdk', cwd: getAgentWorkspaceCwd(workspace, input.sessionId), modelId: input.modelId!, permissionMode: 'safe' }), transport)
      await fetch('https://example.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: input.modelId, max_tokens: 100, messages: [{ role: 'user', content: input.userMessage }] }) })
      let content: string
      if (command.role === 'reviewer') {
        const { assertOwnerReviewerTextDelivery } = await import('../../../main/lib/project-owner-text-delivery')
        const artifact = assertOwnerReviewerTextDelivery(execution.ownerCommandId)
        const step = database.getProjectDb().prepare('SELECT payload FROM project_owner_task_step_links WHERE task_id=?').get(execution.entityId) as { payload: string }
        const acceptanceCriteria = (JSON.parse(step.payload) as { projection: { acceptanceCriteria: string[] } }).projection.acceptanceCriteria
        if (!artifact) throw new Error('fake Reviewer 缺少已验收员工成果')
        // 每条标准引用完整成果中的真实原文摘录（≤1000字符），与生产校验一致。
        const quoteFor = (criterion: string): string => {
          const anchor = criterion.includes('页码') ? '（第1页）' : criterion.includes('离线') ? '完全离线、无网络请求' : criterion.includes('随机生成') ? '每步随机生成2或4' : criterion.includes('判负') ? '无路可走判负' : criterion.includes('最高分') ? '得分与最高分（localStorage）展示，可重新开始' : criterion.includes('测试验证') ? '文件内置合并、随机生成与判负的自测断言并已通过' : criterion.includes('阶段划分') ? '先测量、再双轨、最后演练' : criterion.includes('客户配合') ? '先检查暂停条件再检查达标' : criterion.includes('数字') ? '未引入外部检索或推测' : criterion.includes('内部讨论') ? 'FDE 落地要点' : '目标已收到'
          const index = artifact.content.indexOf(anchor)
          if (index < 0) throw new Error(`fake Reviewer 找不到标准锚点原文：${anchor}`)
          return artifact.content.slice(index, index + 40)
        }
        content = JSON.stringify({ schemaVersion: 2, artifactHash: artifact.contentSha256, verdict: 'approved', summary: '完整成果符合当前范围', criteria: acceptanceCriteria.map(criterion => ({ criterion, status: 'met', evidence: `完整文本成果可核对该标准（${criterion.slice(0, 18)}…）`, quote: quoteFor(criterion) })), findings: [], blockerReason: null })
      } else if (task.title.includes('2048')) {
        content = `已完成网页版2048游戏，交付为可直接在浏览器打开的单文件页面。\n\n完整交付文件 index.html 内容如下：\n\n\`\`\`html\n${GAME_HTML}\n\`\`\`\n\n实现说明：方向键移动、相同数字合并、每步随机生成2或4；无路可走判负，达成2048后可继续；得分与最高分（localStorage）展示，可重新开始；完全离线、无网络请求；文件内置合并、随机生成与判负的自测断言并已通过。`
      } else {
        content = `已完成《FDE落地要点》分析文档（基于所给PDF方案，页码随引标注）。\n\n# FDE 落地要点\n\n1. 起步范围：从 S1 feeding error prevention 与 S2 batch traceability 两个场景切入（第1页），先跑通再扩大投入。\n2. 基线先行：试点前完成 4-week baseline（第1页），生产、质量、财务三方确认同一口径。\n3. 试点节奏：10-week pilot（第2页），先测量、再双轨、最后演练，每步有放行条件。\n4. 收益与回收：年化毛收益 3.08M CNY、扣运维后 2.58M（第2页）；保守回收期约 36 months（第2页），需进场实测后重算。\n5. 商务结构：按里程碑 3:4:2:1 付款、预付款不超过30%（第2页），合同先约定交付、验收与退出。\n6. 退出条件：先检查暂停条件再检查达标；未覆盖的验收组合不自动判为通过（第2页）。\n\n以上数字与事实均来自所给PDF原文，未引入外部检索或推测。`
      }
      const message = { id: randomUUID(), role: 'assistant' as const, content, createdAt: Date.now() }
      ;(await import('../../../main/lib/agent-session-manager')).appendAgentMessage(input.sessionId, message)
      handlers.onComplete([message])
      return
    }
    const source = resolveOwnerPlanningSession(input.sessionId)
    if (!source) throw new Error('测试 Runner 找不到 Owner 来源')
    const body = JSON.stringify({
      model: source.binding.modelId,
      stream: true,
      max_tokens: source.link.maxOutputTokens,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: source.request.systemPrompt }, { role: 'user', content: source.request.userPrompt }],
    })
    claimOwnerPlanningProviderRequest(input.sessionId, body, new URL('https://example.invalid/v1/chat/completions'))
    const objective: string = source.context.goal.goal.objective
    let result: Record<string, unknown>
    if (source.context.conversation?.deliveryReview?.qualityDecisionVersion === 1 && source.context.conversation.deliveryReview.artifact && source.context.conversation.executionObservation) {
      calls.push('owner_quality')
      const artifact = source.context.conversation.deliveryReview.artifact
      const review = source.context.conversation.deliveryReview.review
      // 质量决定的每条引用必须是完整成果内的真实原文摘录（≤1000字符），与生产协议一致。
      const quoteFor = (criterion: string): string => {
        const anchor = criterion.includes('页码') ? '（第1页）' : criterion.includes('离线') ? '完全离线、无网络请求' : criterion.includes('随机生成') ? '每步随机生成2或4' : criterion.includes('判负') ? '无路可走判负' : criterion.includes('最高分') ? '得分与最高分（localStorage）展示，可重新开始' : criterion.includes('测试验证') ? '文件内置合并、随机生成与判负的自测断言并已通过' : criterion.includes('阶段划分') ? '先测量、再双轨、最后演练' : criterion.includes('客户配合') ? '先检查暂停条件再检查达标' : criterion.includes('数字') ? '未引入外部检索或推测' : criterion.includes('内部讨论') ? 'FDE 落地要点' : '目标已收到'
        const index = artifact.content.indexOf(anchor)
        if (index < 0) throw new Error(`fake 质量决定找不到标准锚点原文：${anchor}`)
        return artifact.content.slice(index, index + 40)
      }
      const response = {
        schemaVersion: 1,
        kind: 'quality_decision',
        binding: { projectId: source.link.projectId, goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint },
        messageId: source.context.conversation!.throughMessageId,
        message: '成果与独立检查已完成核对，正在记录验收结果。',
        decision: {
          reviewerCommandId: source.context.conversation.executionObservation.commandId,
          artifactHash: artifact.contentSha256,
          verdict: 'accept',
          reason: '已按完整成果、验收标准与独立评审核对',
          criteria: (review ?? { criteria: [] }).criteria.map(item => ({ criterion: item.criterion, status: 'met', evidence: '成果与独立评审均包含对应依据', quote: quoteFor(item.criterion) })),
          findings: [],
        },
      }
      result = response
    } else if (source.context.conversation?.executionObservation) {
      calls.push('owner_followup')
      result = { schemaVersion: 1, kind: 'conversation_reply', projectId: source.link.projectId, goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint, messageId: source.context.conversation.throughMessageId, message: '我已记录当前进度，等独立检查完成后再核对成果。' }
    } else if (source.link.purpose === 'owner_planning') {
      calls.push(source.link.purpose)
      const roleKey = source.context.sources.roles[0]?.key
      if (!roleKey) throw new Error('隔离项目没有规划岗位')
      const proposal = objective.includes('2048')
        ? {
          summary: '交付一个可直接在浏览器打开游玩的网页版2048游戏',
          assumptions: ['经典2048规则即可，无需联网对战'],
          risks: ['浏览器localStorage不可用时最高分无法持久化'],
          steps: [{
            key: 'game',
            title: '实现2048游戏页面',
            outcome: '包含完整游戏逻辑、可直接打开的单文件网页',
            acceptanceCriteria: [
              '4×4棋盘，方向键移动，相同数字合并，每步随机生成2或4',
              '无可合并且无空格时判负，达成2048后可继续游玩',
              '显示当前得分与本地最高分，可重新开始',
              '完全离线运行，无网络请求',
              '合并、生成与判负逻辑经过测试验证',
            ],
            dependencies: [],
            roleKey,
          }],
        }
        : {
          summary: '基于方案PDF整理FDE落地要点分析，作为向客户推进的内部作战基础',
          assumptions: ['仅以所给PDF为资料来源'],
          risks: ['正式推进前需以进场实测校准收益数字'],
          steps: [{
            key: 'analysis',
            title: '整理FDE落地要点分析',
            outcome: '《FDE落地要点》分析文档，含页码引用',
            acceptanceCriteria: [
              '提炼方案的落地逻辑与关键放行条件并标注来源页码',
              '给出阶段划分、客户配合项与暂停/退出判断',
              '不编造PDF中不存在的数字，引用数字与原文一致',
              '结构清晰，可直接用于内部讨论',
            ],
            dependencies: [],
            roleKey,
          }],
        }
      result = { schemaVersion: 1, kind: 'plan_proposal', binding: { projectId: source.link.projectId, goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint }, proposal }
    } else {
      calls.push(source.link.purpose)
      const context = source.assignmentContext
      if (!context) throw new Error('隔离安排请求没有团队候选')
      const reviewer = context.candidates.find(item => item.roleTemplateId === 'delivery-verifier' || item.name === '独立检查')
      const step = context.steps[0]
      const executor = context.candidates.find(item => item.roleTemplateId === step?.roleKey) ?? context.candidates.find(item => item.id !== reviewer?.id)
      if (!reviewer || !executor || !step) throw new Error('隔离团队不能满足方案岗位和独立检查')
      const workspaceId = context.workspaces.find(workspace => [executor, reviewer].every(employee => employee.workspaceIds.includes(workspace.id)))?.id
      if (!workspaceId) throw new Error('隔离安排没有员工共同授权的工作区')
      result = {
        schemaVersion: 1,
        contextFingerprint: context.contextFingerprint,
        selectedStepKeys: context.steps.map(item => item.key),
        scopeReason: '按确认后的结果范围组织执行',
        workspaceId,
        workspaceReason: '使用用户刚确认纳入项目范围的团队工作区',
        executionKind: 'controlled',
        executionKindReason: '本次交付不需要修改代码',
        assignments: context.steps.map(item => ({ roleKey: item.roleKey, employeeId: executor.id, reason: '现有员工能力适配本步骤' })),
        reviewerEmployeeId: reviewer.id,
        reviewerReason: '由另一位员工独立检查成果',
      }
    }
    handlers.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: input.sessionId, finish_reason: 'stop', result: JSON.stringify(result), usage: { input_tokens: 10, output_tokens: 30 }, owner_planning_usage: { inputTokens: 10, outputTokens: 30, cacheReadTokens: null, cacheWriteTokens: null } } })
  })
})

afterAll(async () => {
  await journeyBrowser?.close()
  employees.stopAgentEmployeeHeartbeat()
  database.closeProjectDb()
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  rmSync(directory, { recursive: true, force: true })
})

interface JourneyOptions {
  objective: string
  constraints: string[]
  proposalSummary: string
  /** 案例B：登记知识资料源并在UI勾选，验证资料范围进入执行授权。 */
  knowledgeSource?: { name: string; pdfPath: string }
  assertDelivered: (context: { deliveryContent: string; projectId: string; runHtml: (html: string) => Promise<{ cellCount: number; tileCount: number; bestScore: string; errors: string[] }> }) => Promise<void> | void
}

async function runRealCaseJourney(options: JourneyOptions): Promise<void> {
  const callStart = calls.length
  const employeeStart = employeeCalls.length
  windowStart = { calls: callStart, employees: employeeStart }
  const project = createProject({ title: `真实案例隔离项目-${randomUUID().slice(0, 6)}`, description: '' })
  const workspace = createAgentWorkspace(`owner-real-case-${randomUUID()}`)
  const teamWorkspace = createAgentWorkspace(`owner-team-case-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'Owner real case fake', provider: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'fake-only', enabled: true, models: [{ id: 'deepseek-flash', name: '隔离模型', enabled: true }] })
  const owner = employees.createAgentEmployee({ name: 'Owner', role: '项目管理者', description: '真实案例旅程Owner载体', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'deepseek-flash', workspaceIds: [workspace.id] })
  for (const [name, roleTemplateId] of [['需求分析师', 'requirements-analyst'], ['独立检查', 'delivery-verifier']] as const) {
    employees.createAgentEmployee({ name, role: name, roleTemplateId, description: '真实案例隔离员工', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'deepseek-flash', workspaceIds: [teamWorkspace.id] })
  }
  saveProjectOwnerGoalDraft(project.id, 0, { objective: options.objective })
  saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '真实案例隔离旅程' })
  const oldDelegationInput = { projectId: project.id, requestId: randomUUID(), maxRequests: 8, maxCostMicros: 15_000_000, expiresAt: Date.now() + 24 * 3600000 }
  const oldDelegationPreview = managementDelegation.previewOwnerManagementDelegation(oldDelegationInput)
  managementDelegation.confirmOwnerManagementDelegation({ input: oldDelegationInput, previewHash: oldDelegationPreview.previewHash })
  saveProjectOwnerGoalDraft(project.id, 1, { objective: options.objective, constraints: options.constraints })
  expect(managementDelegation.getOwnerManagementDelegation(project.id).state).toBe('stale')
  if (options.knowledgeSource) {
    const source = knowledgeCatalog.createSource({ type: 'file', name: options.knowledgeSource.name, locator: options.knowledgeSource.pdfPath })
    const base = knowledgeCatalog.createKnowledgeBase({ name: `${options.knowledgeSource.name}-资料库`, sourceIds: [source.id] })
    knowledgeCatalog.bindProject({ projectId: project.id, knowledgeBaseId: base.id })
  }
  const scheduler = await import('../../../main/lib/project-owner-autonomous-scheduler')
  const scheduleEvents = await import('../../../main/lib/project-owner-autonomous-scheduler-events')
  const stopWake = scheduleEvents.onOwnerAutonomousScheduleWake(projectId => { if (projectId === project.id) void scheduler.runOwnerAutonomousSchedule(projectId) })
  const stopManagement = startOwnerManagementLoop()
  const apiNames = new Map<string, string>([
    ['getOwnerGoalDraft', PROJECT_IPC_CHANNELS.GET_OWNER_GOAL_DRAFT], ['saveOwnerGoalDraft', PROJECT_IPC_CHANNELS.SAVE_OWNER_GOAL_DRAFT],
    ['getOwnerManagement', PROJECT_IPC_CHANNELS.GET_OWNER_MANAGEMENT], ['sendOwnerManagementMessage', PROJECT_IPC_CHANNELS.SEND_OWNER_MANAGEMENT_MESSAGE], ['getOwnerManagementDelegation', PROJECT_IPC_CHANNELS.GET_OWNER_MANAGEMENT_DELEGATION],
    ['previewOwnerManagementDelegation', PROJECT_IPC_CHANNELS.PREVIEW_OWNER_MANAGEMENT_DELEGATION], ['confirmOwnerManagementDelegation', PROJECT_IPC_CHANNELS.CONFIRM_OWNER_MANAGEMENT_DELEGATION], ['confirmOwnerTeamWorkspaceAccess', PROJECT_IPC_CHANNELS.CONFIRM_OWNER_TEAM_WORKSPACE_ACCESS],
    ['getOwnerPlanDraft', PROJECT_IPC_CHANNELS.GET_OWNER_PLAN_DRAFT], ['getOwnerPlanningContext', PROJECT_IPC_CHANNELS.GET_OWNER_PLANNING_CONTEXT], ['listOwnerPlanHistory', PROJECT_IPC_CHANNELS.LIST_OWNER_PLAN_HISTORY], ['saveOwnerPlanDraft', PROJECT_IPC_CHANNELS.SAVE_OWNER_PLAN_DRAFT], ['confirmOwnerPlanDraft', PROJECT_IPC_CHANNELS.CONFIRM_OWNER_PLAN_DRAFT],
    ['getOwnerRuntimeBinding', PROJECT_IPC_CHANNELS.GET_OWNER_RUNTIME_BINDING], ['ensureOwnerRuntimeBinding', PROJECT_IPC_CHANNELS.ENSURE_OWNER_RUNTIME_BINDING], ['saveOwnerRuntimeBinding', PROJECT_IPC_CHANNELS.SAVE_OWNER_RUNTIME_BINDING], ['listOwnerPlanningRuns', PROJECT_IPC_CHANNELS.LIST_OWNER_PLANNING_RUNS], ['prepareOwnerPlanning', PROJECT_IPC_CHANNELS.PREPARE_OWNER_PLANNING],
    ['getOwnerExecutionPreparation', PROJECT_IPC_CHANNELS.GET_OWNER_EXECUTION_PREPARATION], ['listOwnerExecutionPreparationHistory', PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_PREPARATION_HISTORY], ['previewOwnerExecutionPreparation', PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_PREPARATION], ['saveOwnerExecutionPreparation', PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_PREPARATION],
    ['listOwnerExecutionAssignmentRuns', PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_ASSIGNMENT_RUNS], ['prepareOwnerExecutionAssignment', PROJECT_IPC_CHANNELS.PREPARE_OWNER_EXECUTION_ASSIGNMENT],
    ['previewOwnerExecutionGrantIssue', PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_GRANT_ISSUE], ['confirmOwnerExecutionGrantIssue', PROJECT_IPC_CHANNELS.CONFIRM_OWNER_EXECUTION_GRANT_ISSUE], ['previewOwnerExecutionGrantRevoke', PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_GRANT_REVOKE], ['confirmOwnerExecutionGrantRevoke', PROJECT_IPC_CHANNELS.CONFIRM_OWNER_EXECUTION_GRANT_REVOKE],
    ['getOwnerExecutionGrant', PROJECT_IPC_CHANNELS.GET_OWNER_EXECUTION_GRANT], ['listOwnerExecutionGrantHistory', PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_GRANT_HISTORY], ['getOwnerExecutionRevalidation', PROJECT_IPC_CHANNELS.GET_OWNER_EXECUTION_REVALIDATION], ['listOwnerExecutionRevalidationHistory', PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_REVALIDATION_HISTORY], ['getOwnerTaskMaterialization', PROJECT_IPC_CHANNELS.GET_OWNER_TASK_MATERIALIZATION], ['listOwnerTaskMaterializationHistory', PROJECT_IPC_CHANNELS.LIST_OWNER_TASK_MATERIALIZATION_HISTORY], ['listOwnerExecutionCommands', PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_COMMANDS], ['getOwnerAutonomousScheduleStatus', PROJECT_IPC_CHANNELS.GET_OWNER_AUTONOMOUS_SCHEDULE_STATUS],
    ['previewOwnerExecutionRevalidation', PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_REVALIDATION], ['saveOwnerExecutionRevalidation', PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_REVALIDATION], ['previewOwnerTaskMaterialization', PROJECT_IPC_CHANNELS.PREVIEW_OWNER_TASK_MATERIALIZATION], ['materializeOwnerTasks', PROJECT_IPC_CHANNELS.MATERIALIZE_OWNER_TASKS],
    ['saveOwnerExecutionStartIntent', PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_START_INTENT], ['resumeOwnerExecutionStartIntent', PROJECT_IPC_CHANNELS.RESUME_OWNER_EXECUTION_START_INTENT],
  ])
  const entry = join(directory, `entry-${project.id}.tsx`)
  writeFileSync(entry, `
import React from 'react';import {createRoot} from 'react-dom/client';import {Provider,createStore} from 'jotai';
import {ProjectOwnerConversation} from ${JSON.stringify(join(renderer, 'components/projects/ProjectOwnerConversation.tsx'))};
const projectId=${JSON.stringify(project.id)},channels=${JSON.stringify(Object.fromEntries(apiNames))};
const invoke=(name,payload)=>fetch('/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,payload})}).then(response=>response.json());
const projectApi=Object.fromEntries(Object.entries(channels).map(([name,channel])=>[name,payload=>invoke(channel,payload)]));
window.electronAPI={getSettings:async()=>({}),listChannels:async()=>invoke('listChannels'),listAgentWorkspaces:async()=>invoke('listAgentWorkspaces'),createAgentWorkspace:async name=>invoke('createAgentWorkspace',{name}),paa:{project:projectApi,projectWorkspace:{listByProject:async id=>invoke('listProjectWorkspaceBindings',{projectId:id}),bind:async(projectId,workspaceId)=>invoke('bindWorkspaceToProject',{projectId,workspaceId})},agentEmployees:{list:async()=>invoke('listEmployees'),create:async input=>invoke('createEmployee',{input}),getControlledTaskStartPreview:async taskId=>invoke('getControlledTaskStartPreview',{taskId}),startControlledTask:async input=>invoke('startControlledTask',input)}}};
projectApi.onOwnerManagementChanged=callback=>{let seen=new Set();const timer=setInterval(async()=>{const response=await projectApi.getOwnerManagement({projectId});if(!response.ok)return;for(const message of response.value.messages){if(seen.has(message.id))continue;seen.add(message.id);callback({projectId,messageId:message.id})}},100);return()=>clearInterval(timer)};
createRoot(document.getElementById('root')).render(<Provider store={createStore()}><ProjectOwnerConversation projectId=${JSON.stringify(project.id)}/></Provider>);
`)
  const handlers = new Map(ipcHandlers)
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/invoke') return new Response('<html><body><div id="root"></div><script src="/entry.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } })
    const body = await request.json() as { name: string; payload?: unknown }
    bridgeCalls.push(body.name)
    if (body.name === 'listChannels') return Response.json(listChannels())
    if (body.name === 'listAgentWorkspaces') return Response.json(listAgentWorkspaces())
    if (body.name === 'getControlledTaskStartPreview') return Response.json(controlledTasks.getControlledTaskStartPreview((body.payload as { taskId: string }).taskId))
    if (body.name === 'startControlledTask') return Response.json(await controlledTasks.startControlledTask(body.payload))
    if (body.name === 'createAgentWorkspace') return Response.json(createAgentWorkspace((body.payload as { name: string }).name))
    if (body.name === 'listProjectWorkspaceBindings') return Response.json(listProjectWorkspaceBindings(project.id))
    if (body.name === 'bindWorkspaceToProject') return Response.json(bindWorkspaceToProject(project.id, (body.payload as { workspaceId: string }).workspaceId))
    if (body.name === 'listEmployees') return Response.json(employees.listAgentEmployees().map(employee => ({ ...employee, skills: employee.skills ?? [] })))
    if (body.name === 'createEmployee') return Response.json({ ...employees.createAgentEmployee((body.payload as { input: Parameters<typeof employees.createAgentEmployee>[0] }).input), skills: [] })
    const handler = handlers.get(body.name)
    if (!handler) return Response.json({ ok: false, error: { code: 'failed', message: `未注册生产IPC：${body.name}` } })
    const value = await handler(undefined, body.payload)
    return Response.json(value)
  }, routes: { '/entry.js': () => new Response(Bun.file(join(directory, `entry-${project.id}.js`))) } })
  const bundle = await build({ entryPoints: [entry], outfile: join(directory, `entry-${project.id}.js`), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  void bundle
  // 两个案例共用浏览器进程，各自新建Context隔离页面状态；避免在同一Bun用例内反复关闭/启动进程。
  journeyBrowser ??= await chromium.launch({ headless: true })
  const context = await journeyBrowser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const debug = async () => JSON.stringify({ calls: calls.slice(windowStart.calls), employeeCalls: employeeCalls.slice(windowStart.employees), body: (await page.locator('body').innerText()).slice(-8000), planState: getProjectOwnerPlanDraft(project.id)?.state, ownerMessages: getOwnerManagementConversation(project.id).messages.slice(-6), errors }, null, 2)
  const runHtml = async (html: string): Promise<{ cellCount: number; tileCount: number; bestScore: string; errors: string[] }> => {
    const gameServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) })
    const errorStart = errors.length
    try {
      await page.goto(`http://127.0.0.1:${gameServer.port}`)
      return {
        cellCount: await page.locator('#board .cell').count(),
        tileCount: await page.locator('#board .cell:not(:empty)').count(),
        bestScore: await page.locator('#best').innerText(),
        errors: errors.slice(errorStart),
      }
    } finally {
      gameServer.stop(true)
    }
  }
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByLabel('Owner管理委托').waitFor()
    await page.getByRole('button', { name: '重新核对当前授权', exact: true }).waitFor()
    await page.getByLabel('项目总模型费用上限（美元）').fill('15')
    // 初始预算不足时按界面提示重新核对，并确认更新后的预算。
    const confirmScope = page.getByRole('button', { name: '确认范围，让 Owner 自主推进', exact: true })
    const retryScope = page.getByRole('button', { name: '重新核对授权范围', exact: true })
    await confirmScope.or(retryScope).first().waitFor({ timeout: 30000 }).catch(async cause => { throw new Error(`${String(cause)}\n${await debug()}`) })
    if (await retryScope.isVisible()) await retryScope.click()
    await page.getByText('项目总模型费用上限为 $15.00', { exact: false }).waitFor().catch(async cause => { throw new Error(`${String(cause)}\n${await debug()}`) })
    await confirmScope.click()
    const teamScope = page.getByLabel('团队工作区范围建议').last()
    await teamScope.waitFor()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(getOwnerManagementConversation(project.id).messages.filter(message => message.teamWorkspaceProposal)).toHaveLength(1)
    await teamScope.getByRole('button', { name: '允许本项目使用这个团队工作区', exact: true }).click()
    await page.getByText('范围已确认，Owner正在继续核对团队安排。', { exact: true }).waitFor()
    await page.getByLabel('Owner方案摘要').getByText(options.proposalSummary, { exact: true }).waitFor().catch(async cause => { throw new Error(`${String(cause)}\n${await debug()}`) })
    // 自主管理委托包含方案决策与派工；方案摘要是进度信息，不再要求用户批准普通方案或再次开工。
    expect(calls.slice(callStart)).toContain('owner_planning')
    expect(calls.slice(callStart)).toContain('owner_execution_assignment')
    expect(getProjectOwnerPlanDraft(project.id)?.state).toBe('confirmed')
    expect(await page.getByRole('button', { name: '确认方案并开始执行', exact: true }).count()).toBe(0)
    if (options.knowledgeSource) {
      const knowledgeSource = options.knowledgeSource
      // 该隔离夹具未建立知识索引，因此只核对来源进入项目资料目录；不声称资料已注入执行上下文。
      const registered = knowledgeCatalog.listSources().find(source => source.locator === knowledgeSource.pdfPath)
      expect(registered?.enabled).toBe(true)
    }
    for (let attempt = 0; attempt < 400 && !getOwnerManagementConversation(project.id).messages.some(message => message.kind === 'delivery'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      if (attempt > 0 && attempt % 60 === 0) console.warn(`[真实案例旅程] 等待交付中 attempt=${attempt} calls=${JSON.stringify(calls.slice(windowStart.calls))} employees=${JSON.stringify(employeeCalls.slice(windowStart.employees))}`)
    }
    await page.getByLabel('已验收成果').waitFor().catch(async cause => { throw new Error(`${String(cause)}\n${await debug()}`) })
    expect(calls.slice(windowStart.calls)).toContain('owner_execution_assignment')
    expect(calls.slice(windowStart.calls)).toContain('owner_quality')
    expect(employeeCalls.slice(windowStart.employees)).toEqual(['executor', 'reviewer'])
    expect(errors).toEqual([])
    const deliveryMessage = getOwnerManagementConversation(project.id).messages.find(message => message.kind === 'delivery')
    expect(deliveryMessage).toBeDefined()
    const deliveryContent = JSON.stringify(deliveryMessage)
    await options.assertDelivered({ deliveryContent, projectId: project.id, runHtml })
  } finally {
    await context.close()
    server.stop(true)
    stopManagement()
    stopWake()
    // 一个案例结束后停用其管理主体，避免下一案例的全局团队变化唤醒旧项目。
    const managementStore = await import('../../../main/lib/project-owner-management-store')
    const manager = managementStore.getOwnerManager(project.id)
    if (manager?.status === 'active') managementStore.setOwnerManagerStatus(project.id, manager.revision, 'paused')
    // 排水：让上一测试的回调/心跳微任务完成，避免污染下一测试窗口。
    await new Promise(resolve => setTimeout(resolve, 400))
  }
}

browserTest('Given两个定稿真实案例 When逐一确认范围 Then Owner分别自动组织执行独立检查并交付成果', async () => {
  // 共用一个隔离 SQLite 与 Runner harness，显式串行以避免 Bun 并发用例交叉唤醒。
  await runRealCaseJourney({
    objective: '做一个网页版2048游戏，可直接在浏览器打开游玩',
    constraints: ['完全离线运行，无网络请求', '不部署上线', '不改动项目目录之外的文件'],
    proposalSummary: '交付一个可直接在浏览器打开游玩的网页版2048游戏',
    assertDelivered: async ({ deliveryContent, runHtml }) => {
      expect(deliveryContent).toContain('<!DOCTYPE html>')
      expect(deliveryContent).toContain('2048')
      expect(deliveryContent).toContain('ArrowLeft')
      expect(deliveryContent).toContain('localStorage')
      expect(deliveryContent).not.toContain('http://127.0.0.1')
      const delivery = JSON.parse(deliveryContent) as { delivery: { items: Array<{ content: string }> } }
      const htmlContent = delivery.delivery.items.find(item => item.content.includes('<!DOCTYPE html>'))?.content
      const html = htmlContent?.match(/```html\n([\s\S]*?)\n```/)?.[1]
      expect(html).toBeDefined()
      const game = await runHtml(html!)
      expect(game.cellCount).toBe(16)
      expect(game.tileCount).toBe(2)
      expect(game.bestScore).toBe('0')
      // 页面加载时会执行成果中的内置合并、随机生成和判负断言。
      expect(game.errors).toEqual([])
      const grantRows = database.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_execution_grants').get() as { n: number }
      expect(grantRows.n).toBeGreaterThanOrEqual(1)
    },
  })
  const teamWorkspaceDir = join(directory, 'fde-materials')
  mkdirSync(teamWorkspaceDir, { recursive: true })
  const pdfPath = join(teamWorkspaceDir, '复合调味料食品厂_AI引入方案_隔离副本.pdf')
  writeFileSync(pdfPath, buildTextPdf(FDE_PDF_PAGES))
  await runRealCaseJourney({
    objective: '基于《复合调味料食品厂_AI引入方案》PDF产出FDE落地要点分析，作为向客户推进的内部作战基础',
    constraints: ['仅基于已提供的PDF资料，不外部检索', '不编造资料中不存在的数字', '关键结论标注来源页码'],
    proposalSummary: '基于方案PDF整理FDE落地要点分析，作为向客户推进的内部作战基础',
    knowledgeSource: { name: '复合调味料食品厂AI引入方案（隔离副本）', pdfPath },
    assertDelivered: async ({ deliveryContent, projectId }) => {
      expect(deliveryContent).toContain('（第1页）')
      expect(deliveryContent).toContain('（第2页）')
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default
      const extracted = (await pdfParse(Buffer.from(await Bun.file(pdfPath).arrayBuffer()))).text
      for (const fact of FDE_CITED_FACTS) expect(extracted).toContain(fact)
      // 资料源已登记进项目知识目录（隔离环境不勾选；fence准入留待集成知识索引环境）
      const registered = knowledgeCatalog.listSources().find(source => source.locator === pdfPath)
      expect(registered?.name).toBe('复合调味料食品厂AI引入方案（隔离副本）')
      expect(registered?.enabled).toBe(true)
    },
  })
}, 180000)
