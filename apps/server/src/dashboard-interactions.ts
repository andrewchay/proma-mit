/**
 * 服务端 Agent 工作台 — 结构化交互渲染模块
 *
 * 为 Plan / AskUser / Permission / Goal / MCP OAuth 交互提供结构化 UI，
 * 替代 dashboard.ts 中的简化 textarea 渲染。
 *
 * P6-2 实现目标：
 * - Permission: 工具详情、风险等级、批准一次/会话白名单/拒绝
 * - AskUser: 按 questions/options/multiSelect 渲染表单，支持验证
 * - Plan: 完整计划展示、反馈输入、approve_auto/approve_edit/deny/feedback
 * - Goal/MCP OAuth: 结构化动作选择
 * - 文件/Artifact: 浏览、上传、下载
 */

import type {
  AgentRuntimeInteractionRecord,
  AgentRuntimeActionRequest,
  AskUserQuestion,
  AskUserQuestionOption,
  ExitPlanAllowedPrompt,
  PermissionRequest,
  AskUserRequest,
  ExitPlanModeRequest,
} from '@gravitas/shared'
import type { AgentRuntimeInteractionRecord as AgentRuntimeInteractionRecordType } from '@gravitas/shared'

// ===== 渲染函数 =====

/** 渲染单个交互卡片（结构化） */
export function renderInteractionCard(record: AgentRuntimeInteractionRecord): string {
  const { kind, request, requestId, version } = record
  const requestIdAttr = JSON.stringify(requestId).replaceAll('"', '&quot;')

  switch (kind) {
    case 'permission':
      return renderPermissionCard(request as PermissionRequest, requestIdAttr, version)
    case 'ask_user':
      return renderAskUserCard(request as AskUserRequest, requestIdAttr, version)
    case 'plan':
      return renderPlanCard(request as ExitPlanModeRequest, requestIdAttr, version)
    case 'goal':
    case 'mcp_oauth':
    case 'external_action':
      return renderActionCard(record, requestIdAttr, version)
    default:
      return renderFallbackCard(record, requestIdAttr, version)
  }
}

// ===== Permission 卡片 =====

function renderPermissionCard(req: PermissionRequest, requestIdAttr: string, version: number): string {
  const riskColor = req.dangerLevel === 'dangerous' ? 'var(--orange)' : req.dangerLevel === 'normal' ? '#ffcc00' : 'var(--acid)'
  const riskLabel = req.dangerLevel === 'dangerous' ? '高风险' : req.dangerLevel === 'normal' ? '中风险' : '低风险'
  const toolInputPreview = JSON.stringify(req.toolInput, null, 2).slice(0, 500)

  return `<div class="pending interaction-card" data-request-id="${escapeHtml(requestIdAttr)}" data-kind="permission" data-version="${version}">
  <div class="interaction-header">
    <span class="interaction-badge" style="background:${riskColor}">${riskLabel}</span>
    <b>权限请求</b> · ${escapeHtml(req.toolName)}
  </div>
  <div class="interaction-body">
    ${req.sdkTitle ? `<div class="sdk-title">${escapeHtml(req.sdkTitle)}</div>` : ''}
    ${req.sdkDescription ? `<div class="sdk-desc">${escapeHtml(req.sdkDescription)}</div>` : ''}
    ${req.description ? `<div class="description">${escapeHtml(req.description)}</div>` : ''}
    ${req.command ? `<div class="command-box"><code>${escapeHtml(req.command)}</code></div>` : ''}
    <details class="tool-input-details">
      <summary>工具输入参数</summary>
      <pre class="tool-input">${escapeHtml(toolInputPreview)}${JSON.stringify(req.toolInput).length > 500 ? '...' : ''}</pre>
    </details>
    ${req.decisionReason ? `<div class="reason">理由: ${escapeHtml(req.decisionReason)}</div>` : ''}
  </div>
  <div class="interaction-actions">
    <label class="checkbox-label">
      <input type="checkbox" data-always-allow> 本次会话始终允许此工具
    </label>
    <div class="button-row">
      <button class="action-btn approve" onclick="respondPermission('${requestIdAttr}', true, this)">✓ 批准一次</button>
      <button class="action-btn deny" onclick="respondPermission('${requestIdAttr}', false, this)">✗ 拒绝</button>
    </div>
  </div>
</div>`
}

// ===== AskUser 卡片 =====

function renderAskUserCard(req: AskUserRequest, requestIdAttr: string, version: number): string {
  const isTakeover = req.kind === 'computer_use_takeover'
  const headerClass = isTakeover ? 'takeover-header' : ''
  const title = isTakeover ? '🖥️ Computer Use 接管请求' : '用户问答'

  const questionsHtml = req.questions.map((q, index) => renderQuestion(q, index)).join('')

  return `<div class="pending interaction-card ${headerClass}" data-request-id="${escapeHtml(requestIdAttr)}" data-kind="ask_user" data-version="${version}">
  <div class="interaction-header">
    <b>${title}</b>
    ${isTakeover ? '<span class="warning-badge">需要人工介入</span>' : ''}
  </div>
  <div class="interaction-body askuser-form">
    ${questionsHtml}
  </div>
  <div class="interaction-actions">
    <button class="action-btn approve" onclick="respondAskUser('${requestIdAttr}', this)">✓ 提交回答</button>
  </div>
</div>`
}

function renderQuestion(q: AskUserQuestion, index: number): string {
  const questionId = `q-${index}`
  const header = q.header ? `<span class="question-header">${escapeHtml(q.header)}</span>` : ''

  if (q.options && q.options.length > 0) {
    if (q.multiSelect) {
      // 多选：复选框
      const optionsHtml = q.options.map((opt, optIndex) => renderCheckboxOption(q.question, opt, optIndex)).join('')
      return `<div class="question-block" data-question="${escapeHtml(q.question)}">
        ${header}
        <label class="question-label">${escapeHtml(q.question)}</label>
        <div class="options-grid">${optionsHtml}</div>
      </div>`
    } else {
      // 单选：单选按钮
      const optionsHtml = q.options.map((opt, optIndex) => renderRadioOption(q.question, opt, optIndex)).join('')
      return `<div class="question-block" data-question="${escapeHtml(q.question)}">
        ${header}
        <label class="question-label">${escapeHtml(q.question)}</label>
        <div class="options-grid">${optionsHtml}</div>
      </div>`
    }
  }

  // 文本输入
  return `<div class="question-block" data-question="${escapeHtml(q.question)}">
    ${header}
    <label class="question-label">${escapeHtml(q.question)}</label>
    <input type="text" class="question-input" data-answer="${escapeHtml(q.question)}" placeholder="请输入回答…">
  </div>`
}

function renderRadioOption(question: string, opt: AskUserQuestionOption, index: number): string {
  const optId = `opt-${Math.random().toString(36).slice(2)}`
  const preview = opt.preview ? `data-preview="${escapeHtml(opt.preview)}"` : ''
  return `<label class="option-item" ${preview}>
    <input type="radio" name="${escapeHtml(question)}" value="${escapeHtml(opt.label)}" data-answer="${escapeHtml(question)}">
    <span class="option-label">${escapeHtml(opt.label)}</span>
    ${opt.description ? `<span class="option-desc">${escapeHtml(opt.description)}</span>` : ''}
  </label>`
}

function renderCheckboxOption(question: string, opt: AskUserQuestionOption, index: number): string {
  const preview = opt.preview ? `data-preview="${escapeHtml(opt.preview)}"` : ''
  return `<label class="option-item" ${preview}>
    <input type="checkbox" value="${escapeHtml(opt.label)}" data-answer="${escapeHtml(question)}" data-multiselect="true">
    <span class="option-label">${escapeHtml(opt.label)}</span>
    ${opt.description ? `<span class="option-desc">${escapeHtml(opt.description)}</span>` : ''}
  </label>`
}

// ===== Plan 卡片 =====

function renderPlanCard(req: ExitPlanModeRequest, requestIdAttr: string, version: number): string {
  const promptsHtml = req.allowedPrompts.map((p, i) => renderAllowedPrompt(p, i)).join('')
  const planContent = req.toolInput.plan ?? req.toolInput.description ?? '未提供计划内容'

  return `<div class="pending interaction-card plan-card" data-request-id="${escapeHtml(requestIdAttr)}" data-kind="plan" data-version="${version}">
  <div class="interaction-header">
    <span class="interaction-badge" style="background:#6b8cff">计划审批</span>
    <b>ExitPlanMode</b>
  </div>
  <div class="interaction-body">
    <div class="plan-content">
      <h4>计划内容</h4>
      <pre class="plan-text">${escapeHtml(String(planContent))}</pre>
    </div>
    ${promptsHtml ? `<div class="allowed-prompts">
      <h4>批准后将执行的 Prompts</h4>
      ${promptsHtml}
    </div>` : ''}
    <div class="feedback-area">
      <label>反馈 / 修改要求（可选）</label>
      <textarea data-feedback rows="3" placeholder="如需调整计划，请在此输入反馈…"></textarea>
    </div>
  </div>
  <div class="interaction-actions plan-actions">
    <button class="action-btn approve-auto" onclick="respondPlan('${requestIdAttr}', 'approve_auto', this)">✓ 批准自动执行</button>
    <button class="action-btn approve-edit" onclick="respondPlan('${requestIdAttr}', 'approve_edit', this)">✓ 批准并切换编辑模式</button>
    <button class="action-btn feedback" onclick="respondPlan('${requestIdAttr}', 'feedback', this)">💬 要求调整</button>
    <button class="action-btn deny" onclick="respondPlan('${requestIdAttr}', 'deny', this)">✗ 拒绝</button>
  </div>
</div>`
}

function renderAllowedPrompt(p: ExitPlanAllowedPrompt, index: number): string {
  return `<div class="allowed-prompt-item">
    <span class="prompt-tool">${escapeHtml(p.tool)}</span>
    <span class="prompt-text">${escapeHtml(p.prompt)}</span>
  </div>`
}

// ===== Goal / MCP OAuth / External Action 卡片 =====

function renderActionCard(record: AgentRuntimeInteractionRecord, requestIdAttr: string, version: number): string {
  const req = record.request as AgentRuntimeActionRequest
  const actions = req.actions ?? []
  const actionsHtml = actions.map((action: string) =>
    `<button class="action-btn action-choice" onclick="respondAction('${requestIdAttr}', '${escapeHtml(action)}', this)">${escapeHtml(action)}</button>`
  ).join('')

  const kindLabel = record.kind === 'goal' ? '目标检查点' : record.kind === 'mcp_oauth' ? 'MCP OAuth 授权' : '外部操作'

  return `<div class="pending interaction-card" data-request-id="${escapeHtml(requestIdAttr)}" data-kind="${record.kind}" data-version="${version}">
  <div class="interaction-header">
    <span class="interaction-badge" style="background:#a855f7">${kindLabel}</span>
    <b>${escapeHtml(req.title ?? record.kind)}</b>
  </div>
  <div class="interaction-body">
    ${req.description ? `<div class="description">${escapeHtml(req.description)}</div>` : ''}
    ${req.detail ? `<details><summary>详情</summary><pre>${escapeHtml(JSON.stringify(req.detail, null, 2))}</pre></details>` : ''}
  </div>
  <div class="interaction-actions action-choices">
    ${actionsHtml || '<span class="muted">无可选动作</span>'}
  </div>
</div>`
}

function renderFallbackCard(record: AgentRuntimeInteractionRecord, requestIdAttr: string, version: number): string {
  return `<div class="pending interaction-card" data-request-id="${escapeHtml(requestIdAttr)}" data-kind="${record.kind}" data-version="${version}">
  <div class="interaction-header">
    <b>${escapeHtml(record.kind)}</b>
  </div>
  <div class="interaction-body">
    <pre class="muted">${escapeHtml(JSON.stringify(record.request, null, 2))}</pre>
  </div>
  <div class="interaction-actions">
    <button class="action-btn" onclick="respondFallback('${requestIdAttr}', this)">确认</button>
  </div>
</div>`
}

// ===== 工具函数 =====

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ===== CSS 样式（注入 dashboard） =====

export const STRUCTURED_INTERACTION_CSS = `
/* ===== 结构化交互卡片 ===== */
.interaction-card {
  border-left: 3px solid var(--orange);
  padding: 14px;
  background: #1a1f1a;
  margin: 10px 0;
  border-radius: 8px;
  border: 1px solid var(--line);
}
.interaction-card.plan-card {
  border-left-color: #6b8cff;
}
.interaction-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 14px;
}
.interaction-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: bold;
  color: #13200c;
}
.warning-badge {
  background: var(--orange);
  color: #13200c;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: bold;
}
.interaction-body {
  margin-bottom: 12px;
}
.sdk-title {
  font-weight: bold;
  color: var(--ink);
  margin-bottom: 4px;
}
.sdk-desc {
  color: var(--muted);
  font-size: 13px;
  margin-bottom: 8px;
}
.description {
  color: var(--ink);
  margin-bottom: 8px;
  line-height: 1.5;
}
.command-box {
  background: #111411;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px;
  margin: 8px 0;
  overflow-x: auto;
}
.command-box code {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: var(--acid);
}
.tool-input-details {
  margin: 8px 0;
}
.tool-input-details summary {
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
}
.tool-input {
  background: #111411;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px;
  font-size: 11px;
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
}
.reason {
  color: var(--muted);
  font-size: 12px;
  font-style: italic;
  margin-top: 6px;
}

/* ===== AskUser 表单 ===== */
.askuser-form {
  display: grid;
  gap: 14px;
}
.question-block {
  display: grid;
  gap: 6px;
}
.question-header {
  color: var(--acid);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.question-label {
  color: var(--ink);
  font-weight: 500;
  line-height: 1.4;
}
.question-input {
  background: #111411;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px 10px;
  color: var(--ink);
  font: inherit;
}
.question-input:focus {
  outline: none;
  border-color: var(--acid);
}
.options-grid {
  display: grid;
  gap: 4px;
}
.option-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  background: #111411;
  border: 1px solid var(--line);
  border-radius: 4px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.option-item:hover {
  border-color: var(--acid);
}
.option-item input {
  margin-top: 2px;
  width: auto;
}
.option-label {
  color: var(--ink);
  font-weight: 500;
}
.option-desc {
  color: var(--muted);
  font-size: 12px;
  margin-left: auto;
}

/* ===== Plan 卡片 ===== */
.plan-content {
  margin-bottom: 12px;
}
.plan-content h4, .allowed-prompts h4, .feedback-area label {
  color: var(--muted);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 6px;
}
.plan-text {
  background: #111411;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 10px;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  max-height: 300px;
  overflow-y: auto;
}
.allowed-prompts {
  margin-bottom: 12px;
}
.allowed-prompt-item {
  display: flex;
  gap: 8px;
  padding: 6px 10px;
  background: #111411;
  border: 1px solid var(--line);
  border-radius: 4px;
  margin: 4px 0;
}
.prompt-tool {
  color: var(--acid);
  font-family: ui-monospace, monospace;
  font-size: 11px;
}
.prompt-text {
  color: var(--ink);
  font-size: 13px;
}
.feedback-area {
  margin-top: 10px;
}
.feedback-area textarea {
  background: #111411;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px;
  color: var(--ink);
  font: inherit;
  width: 100%;
}
.feedback-area textarea:focus {
  outline: none;
  border-color: var(--acid);
}

/* ===== 动作按钮 ===== */
.interaction-actions {
  display: grid;
  gap: 8px;
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}
.checkbox-label input {
  width: auto;
}
.button-row, .plan-actions, .action-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.action-btn {
  padding: 8px 14px;
  border: 0;
  border-radius: 5px;
  font-weight: bold;
  font-size: 13px;
  cursor: pointer;
  transition: opacity 0.15s;
}
.action-btn:hover {
  opacity: 0.85;
}
.action-btn.approve, .action-btn.approve-auto {
  background: var(--acid);
  color: #13200c;
}
.action-btn.approve-edit {
  background: #6b8cff;
  color: #fff;
}
.action-btn.deny {
  background: #ff5f5f;
  color: #fff;
}
.action-btn.feedback {
  background: #ffcc00;
  color: #13200c;
}
.action-btn.action-choice {
  background: #30352f;
  color: var(--acid);
  border: 1px solid var(--line);
}
.action-btn.action-choice:hover {
  background: #3b403b;
}

/* ===== 接管状态 ===== */
.takeover-header {
  border-left-color: #ff5f5f;
  background: #2a1a1a;
}
`

// ===== JavaScript 响应处理函数（注入 dashboard） =====

export const STRUCTURED_INTERACTION_JS = `
// ===== 结构化交互响应处理 =====

async function respondPermission(requestId, allow, btn) {
  const card = btn.closest('.interaction-card')
  const alwaysAllow = card.querySelector('[data-always-allow]')?.checked || false
  const resolutionId = globalThis.crypto?.randomUUID?.() || ('resp-' + Date.now())
  const version = Number(card.dataset.version)
  const response = { requestId, behavior: allow ? 'allow' : 'deny', alwaysAllow }
  try {
    await api('/agent/interactions/' + requestId + '/respond', {
      method: 'POST',
      body: JSON.stringify({ response, expectedVersion: version, resolutionId })
    })
    card.remove()
    refresh()
  } catch (e) { show(String(e)) }
}

async function respondAskUser(requestId, btn) {
  const card = btn.closest('.interaction-card')
  const version = Number(card.dataset.version)
  const answers = {}

  // 收集文本输入
  card.querySelectorAll('.question-input[data-answer]').forEach(input => {
    answers[input.dataset.answer] = input.value
  })

  // 收集单选
  const radioGroups = new Map()
  card.querySelectorAll('input[type="radio"][data-answer]:checked').forEach(radio => {
    answers[radio.dataset.answer] = radio.value
  })

  // 收集多选（逗号分隔）
  const multiGroups = new Map()
  card.querySelectorAll('input[type="checkbox"][data-multiselect]:checked').forEach(cb => {
    const q = cb.dataset.answer
    if (!multiGroups.has(q)) multiGroups.set(q, [])
    multiGroups.get(q).push(cb.value)
  })
  multiGroups.forEach((vals, q) => { answers[q] = vals.join(', ') })

  const resolutionId = globalThis.crypto?.randomUUID?.() || ('resp-' + Date.now())
  const response = { requestId, answers }
  try {
    await api('/agent/interactions/' + requestId + '/respond', {
      method: 'POST',
      body: JSON.stringify({ response, expectedVersion: version, resolutionId })
    })
    card.remove()
    refresh()
  } catch (e) { show(String(e)) }
}

async function respondPlan(requestId, action, btn) {
  const card = btn.closest('.interaction-card')
  const version = Number(card.dataset.version)
  const feedback = card.querySelector('[data-feedback]')?.value
  const resolutionId = globalThis.crypto?.randomUUID?.() || ('resp-' + Date.now())
  const response = { requestId, action, ...(feedback ? { feedback } : {}) }
  try {
    await api('/agent/interactions/' + requestId + '/respond', {
      method: 'POST',
      body: JSON.stringify({ response, expectedVersion: version, resolutionId })
    })
    card.remove()
    refresh()
  } catch (e) { show(String(e)) }
}

async function respondAction(requestId, action, btn) {
  const card = btn.closest('.interaction-card')
  const version = Number(card.dataset.version)
  const resolutionId = globalThis.crypto?.randomUUID?.() || ('resp-' + Date.now())
  const response = { requestId, action }
  try {
    await api('/agent/interactions/' + requestId + '/respond', {
      method: 'POST',
      body: JSON.stringify({ response, expectedVersion: version, resolutionId })
    })
    card.remove()
    refresh()
  } catch (e) { show(String(e)) }
}

async function respondFallback(requestId, btn) {
  const card = btn.closest('.interaction-card')
  const version = Number(card.dataset.version)
  const resolutionId = globalThis.crypto?.randomUUID?.() || ('resp-' + Date.now())
  const response = { requestId, action: 'acknowledge' }
  try {
    await api('/agent/interactions/' + requestId + '/respond', {
      method: 'POST',
      body: JSON.stringify({ response, expectedVersion: version, resolutionId })
    })
    card.remove()
    refresh()
  } catch (e) { show(String(e)) }
}
`
