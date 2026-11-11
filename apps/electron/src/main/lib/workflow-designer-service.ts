/** Workflow 对话式设计器：模型只提出 patch，绝不直接写入 Definition。 */

import { z } from 'zod'
import type { AgentMessage, AgentSendInput, WorkflowDefinition, WorkflowPatchProposal } from '@gravitas/shared'
import { WorkflowPatchSchema } from '@gravitas/shared/workflow'
import { createAgentSession, getAgentSessionSDKMessages } from './agent-session-manager'
import { runAgentHeadless } from './agent-service'

const DesignerResponseSchema = z.object({ reply: z.string().min(1).max(2000), patches: z.array(WorkflowPatchSchema).max(30) })

function extractDesignerJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const parsed: unknown = JSON.parse((fenced?.[1] ?? text).trim())
  if (typeof parsed === 'string' && /^[\s]*[\[{]/.test(parsed)) return JSON.parse(parsed)
  return parsed
}

function readSessionAssistantText(sessionId: string): string | undefined {
  const messages = getAgentSessionSDKMessages(sessionId)
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.type !== 'assistant' || typeof message.message !== 'object' || message.message === null || !('content' in message.message)) continue
    const content = message.message.content
    if (typeof content === 'string' && content.trim()) return content
    if (!Array.isArray(content)) continue
    const text = (content as unknown[])
      .filter((block): block is { type: 'text'; text: string } => typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n').trim()
    if (text) return text
  }
  return undefined
}

function buildDesignerPrompt(definition: WorkflowDefinition, instruction: string): string {
  return `你是 PAA Workflow 设计器。你只能返回一个 JSON 对象，禁止 Markdown、工具调用或额外文本。\nJSON 格式：{"reply":"给用户的简短说明","patches":[WorkflowPatch...]}\n允许的 op：set_metadata、set_trigger、add_node、update_node、remove_node、add_edge、remove_edge、move_node。\n约束：不要写入凭证、API Key、Token 或密码；不能删除 start/end；新增节点必须使用唯一安全 ID；修改后必须保持从 start 到 end 的 DAG；引用 Skill/MCP 时只写名字而非凭证。设置 schedule trigger 时 config 必须包含 mode、channelId；interval 模式还必须包含 interval。用户请求不清晰时返回空 patches 并提出一个澄清问题。\n\n当前 Definition：\n${JSON.stringify(definition)}\n\n用户请求：${instruction}`
}

export async function proposeWorkflowPatches(definition: WorkflowDefinition, instruction: string, channelId: string, modelId?: string): Promise<WorkflowPatchProposal> {
  if (!instruction.trim()) throw new Error('Workflow 设计请求不能为空')
  const session = createAgentSession(`Workflow 设计：${definition.name}`, channelId, definition.workspaceId)
  let resultMessages: AgentMessage[] = []
  let failure: string | null = null
  let stopped = false
  const input: AgentSendInput = { sessionId: session.id, userMessage: buildDesignerPrompt(definition, instruction), channelId, ...(modelId ? { modelId } : {}), workspaceId: definition.workspaceId, permissionModeOverride: 'auto', workflowCapabilityPolicy: { allowedTools: [], permissionProfileId: 'workflow-readonly' } }
  await runAgentHeadless(input, { onError: (error) => { failure = error }, onComplete: (messages, result) => { resultMessages = messages ?? []; stopped = result?.stoppedByUser === true }, onTitleUpdated: () => {}, source: 'workflow' })
  if (failure) throw new Error(failure)
  if (stopped) throw new Error('Workflow 设计已停止')
  const assistantText = [...resultMessages].reverse().find((message) => message.role === 'assistant' && message.content.trim())?.content
    ?? readSessionAssistantText(session.id)
  if (!assistantText) throw new Error('Workflow 设计器没有返回结果')
  try {
    const result = DesignerResponseSchema.parse(extractDesignerJson(assistantText))
    return { ...result, designerSessionId: session.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知格式错误'
    throw new Error(`Workflow 设计器返回了不安全或无效的 patch: ${message}`)
  }
}
