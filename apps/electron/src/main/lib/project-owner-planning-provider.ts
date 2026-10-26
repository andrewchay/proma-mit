/** 实际序列化请求校验与单发送占位；不是另一份费用授权。 */
import { createHash } from 'node:crypto'
import { getAgentProviderProtocol, type AgentProviderProtocol } from '@gravitas/shared'
import { getChannelById, decryptApiKey } from './channel-manager'
import { resolveOwnerPlanningSession, type OwnerPlanningSessionSource } from './project-owner-planning-source'
import * as store from './project-sqlite-store'
import { assertControlledPreparedExecution } from './controlled-project-task-service'
/** 本地完整性检查不是签名，不认证有任意SQL写权限的攻击者。旧占位不补造证明。 */
export interface OwnerPlanningAdmission {
  link_id: string; execution_id: string; session_id: string; request_hash: string; source_snapshot: string; admitted_at: number; integrity_hash?: string | null
}
export function ownerPlanningAdmissionHash(record: OwnerPlanningAdmission): string {
  return createHash('sha256').update(JSON.stringify({ link_id: record.link_id, execution_id: record.execution_id, session_id: record.session_id, request_hash: record.request_hash, source_snapshot: record.source_snapshot, admitted_at: record.admitted_at })).digest('hex')
}
export function assertOwnerPlanningAdmission(record: OwnerPlanningAdmission): void {
  if (![record.link_id, record.execution_id, record.session_id].every(value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128) || !/^[a-f0-9]{64}$/.test(record.request_hash) || typeof record.source_snapshot !== 'string' || record.source_snapshot.length > 300000 || !Number.isSafeInteger(record.admitted_at) || record.admitted_at <= 0 || record.integrity_hash !== ownerPlanningAdmissionHash(record)) throw new Error('Owner发送占位证据无效，保留原文核查，不生成或补发')
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Owner规划模型请求包含未知或非文本字段')
  return value as Record<string, unknown>
}
function textContent(value: unknown, expected: string): boolean {
  if (value === expected) return true
  if (!Array.isArray(value) || value.length !== 1) return false
  const item = object(value[0], ['type', 'text'])
  return item.type === 'text' && item.text === expected
}
function tools(payload: Record<string, unknown>): void {
  if (payload.tools !== undefined && (!Array.isArray(payload.tools) || payload.tools.length !== 0)) throw new Error('Owner规划禁止任何工具定义')
  if (payload.tool_choice !== undefined && payload.tool_choice !== 'none') throw new Error('Owner规划禁止工具选择')
}
/** body而非上层配置必须匹配。支持三种已知SDK协议，未知参数不默默放行。 */
export function assertOwnerPlanningPayload(source: OwnerPlanningSessionSource, body: unknown, protocol: AgentProviderProtocol, url: URL): void {
  const { systemPrompt, userPrompt } = source.request
  if (protocol === 'google-generative') {
    const payload = object(body, ['contents', 'systemInstruction', 'generationConfig', 'tools', 'toolConfig'])
    const config = object(payload.generationConfig, ['maxOutputTokens'])
    const instruction = object(payload.systemInstruction, ['parts', 'role'])
    if (config.maxOutputTokens !== 4096 || instruction.role !== undefined && instruction.role !== 'system' || !Array.isArray(instruction.parts) || instruction.parts.length !== 1 || object(instruction.parts[0], ['text']).text !== systemPrompt || !Array.isArray(payload.contents) || payload.contents.length !== 1) throw new Error('Owner规划Google请求参数与冻结资料不一致')
    const user = object(payload.contents[0], ['role', 'parts'])
    if (user.role !== 'user' || !Array.isArray(user.parts) || user.parts.length !== 1 || object(user.parts[0], ['text']).text !== userPrompt || payload.tools !== undefined || payload.toolConfig !== undefined || !url.pathname.endsWith(`/models/${encodeURIComponent(source.binding.modelId)}:streamGenerateContent`)) throw new Error('Owner规划Google请求夹带历史、工具或错误出口')
    return
  }
  const payload = object(body, protocol === 'anthropic-messages'
    ? ['model', 'system', 'messages', 'max_tokens', 'stream', 'tools', 'tool_choice']
    : ['model', 'messages', 'max_tokens', 'max_completion_tokens', 'stream', 'stream_options', 'tools', 'tool_choice'])
  tools(payload)
  if (payload.model !== source.binding.modelId || payload.stream !== true || !Array.isArray(payload.messages)) throw new Error('Owner规划实际模型或流式请求无效')
  if (protocol === 'anthropic-messages') {
    if (payload.max_tokens !== 4096 || !textContent(payload.system, systemPrompt) || payload.messages.length !== 1 || !url.pathname.endsWith('/messages')) throw new Error('Owner规划Anthropic请求输出限制/指令/出口不一致')
    const user = object(payload.messages[0], ['role', 'content'])
    if (user.role !== 'user' || !textContent(user.content, userPrompt)) throw new Error('Owner规划请求夹带历史或资料已变')
  } else {
    if ((payload.max_tokens === undefined && payload.max_completion_tokens === undefined) || [payload.max_tokens, payload.max_completion_tokens].some(value => value !== undefined && value !== 4096) || payload.messages.length !== 2 || !url.pathname.endsWith('/chat/completions')) throw new Error('Owner规划OpenAI请求输出限制/历史/出口不一致')
    if (payload.stream_options !== undefined) {
      const options = object(payload.stream_options, ['include_usage'])
      if (options.include_usage !== true) throw new Error('Owner规划请求不能主动隐藏usage')
    }
    const system = object(payload.messages[0], ['role', 'content'])
    const user = object(payload.messages[1], ['role', 'content'])
    if (!['system', 'developer'].includes(String(system.role)) || !textContent(system.content, systemPrompt) || user.role !== 'user' || !textContent(user.content, userPrompt)) throw new Error('Owner规划请求与受审指令/冻结资料不一致')
  }
}
/** 最终凭据也应属于冻结实际渠道；不在记录/错误中泄露header或URL key。 */
export function assertOwnerPlanningCredential(source: OwnerPlanningSessionSource, input: RequestInfo | URL, init?: RequestInit): void {
  const channel = getChannelById(source.binding.channelId)
  if (!channel?.enabled || !channel.apiKey) throw new Error('Owner规划渠道凭据不可用')
  const apiKey = decryptApiKey(channel.id)
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const protocol = getAgentProviderProtocol(channel.provider, 'ai-sdk')
  const url = new URL(input instanceof Request ? input.url : String(input))
  const matches = protocol === 'openai-chat' ? headers.get('authorization') === `Bearer ${apiKey}`
    : protocol === 'anthropic-messages' ? headers.get('x-api-key') === apiKey
    : headers.get('x-goog-api-key') === apiKey || url.searchParams.get('key') === apiKey
  if (!matches) throw new Error('Owner规划实际请求凭据与确认渠道不一致')
}
/** 必须在controlled费用/当前execution核验后的同一个同步事务中调用；占位后的发送失败也不补跑。 */
export function claimOwnerPlanningProviderRequest(sessionId: string, body: string, url: URL): void {
  store.getProjectDb().transaction(() => {
  const source = resolveOwnerPlanningSession(sessionId)
  if (!source) throw new Error('Owner规划最终请求丢失权威用途')
  assertControlledPreparedExecution(source.executionId, 'provider')
  const channel = getChannelById(source.binding.channelId)
  if (!channel?.enabled) throw new Error('Owner规划实际渠道不可用')
  const payload: unknown = JSON.parse(body)
  assertOwnerPlanningPayload(source, payload, getAgentProviderProtocol(channel.provider, 'ai-sdk'), url)
  const existing = store.getProjectDb().prepare('SELECT link_id FROM project_owner_planning_admissions WHERE link_id = ? OR execution_id = ? OR session_id = ?').get(source.link.id, source.executionId, source.sessionId)
  if (existing) throw new Error('Owner规划请求已占位或可能发送，不自动重试；请核查原Run')
  const record: OwnerPlanningAdmission = { link_id: source.link.id, execution_id: source.executionId, session_id: source.sessionId, request_hash: createHash('sha256').update(body).digest('hex'), source_snapshot: JSON.stringify(source.context), admitted_at: Date.now() }
  store.getProjectDb().prepare('INSERT INTO project_owner_planning_admissions (link_id, execution_id, session_id, request_hash, source_snapshot, admitted_at, integrity_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(record.link_id, record.execution_id, record.session_id, record.request_hash, record.source_snapshot, record.admitted_at, ownerPlanningAdmissionHash(record))
  })()
}
