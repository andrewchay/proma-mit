import { createAgentAISDKModel } from '@proma/core/providers/ai-sdk-bridge'
import type { SDKMessage } from '@proma/shared'
import type { AgentRuntimeWebAgentTurnRunner } from '@proma/shared/utils'
import { AGENT_PROVIDER_RUNTIME_CAPABILITIES, resolveAgentRuntimeBaseUrl } from '@proma/shared'
import { isStepCount, jsonSchema, streamText, tool } from 'ai'
import { createWorkspaceReadTools } from './workspace-tools.ts'
import { createWorkspaceWriteTool, writeWorkspaceFile } from './workspace-tools.ts'
import type { AskUserRequest, AskUserResponse, PermissionRequest, PermissionResponse } from '@proma/shared'

/**
 * 服务端 AI SDK 执行器。
 *
 * 提供多步骤流与受控工作区只读工具。写入、Shell 与 MCP 工具不能沿用桌面端
 * 的本地权限模型，必须由 Web 审批与隔离 worker 显式承载。
 */
export const runAISDKWebAgentTurn: AgentRuntimeWebAgentTurnRunner = async (input) => {
  const protocol = input.protocol
    ?? AGENT_PROVIDER_RUNTIME_CAPABILITIES[input.provider].runtimeProtocols?.['ai-sdk']
    ?? AGENT_PROVIDER_RUNTIME_CAPABILITIES[input.provider].protocol
  const model = createAgentAISDKModel({
    provider: input.provider,
    protocol,
    baseUrl: resolveAgentRuntimeBaseUrl(input.provider, 'ai-sdk', input.credential.baseUrl),
    apiKey: input.credential.apiKey,
    modelId: input.modelId,
  })
  const result = streamText({
    model,
    prompt: createPromptWithHistory(input.historyMessages, input.prompt),
    abortSignal: input.signal,
    tools: {
      ...createWorkspaceReadTools(input.workspace.cwd),
      ...createWorkspaceWriteTool(input.workspace.cwd, async (path, content) => {
        await assertPermissionApproved(input, {
          toolName: 'WriteWorkspaceFile',
          toolInput: { path, content },
          description: `写入工作区文件 ${path}`,
          dangerLevel: 'normal',
        })
        return writeWorkspaceFile(input.workspace.cwd, path, content)
      }),
      AskUserQuestion: tool({
        description: '向用户提出需要选择的问题，并等待回答。',
        inputSchema: jsonSchema<{ questions: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }> }> }>({ type: 'object', required: ['questions'], properties: { questions: { type: 'array' } }, additionalProperties: false }),
        execute: async ({ questions }) => JSON.stringify(await askUser(input, questions)),
      }),
      EnterPlanMode: tool({ description: '进入只规划、不执行写操作的模式。', inputSchema: jsonSchema<Record<string, never>>({ type: 'object', additionalProperties: false }), execute: async () => '已进入 Plan 模式；请先给出计划。' }),
      ExitPlanMode: tool({ description: '请求用户批准计划后继续执行。', inputSchema: jsonSchema<{ plan: string }>({ type: 'object', required: ['plan'], properties: { plan: { type: 'string' } }, additionalProperties: false }), execute: async ({ plan }) => { await assertPlanApproved(input, plan); return '计划已获批准，可以继续执行。' } }),
    },
    stopWhen: isStepCount(8),
  })

  let text = ''
  let providerStreamError: unknown
  try { for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      text += part.text
      input.emit({ kind: 'agent_event', event: { type: 'text_delta', text: part.text } })
    } else if (part.type === 'tool-input-start') {
      input.emit({ kind: 'agent_event', event: { type: 'tool_start', toolName: part.toolName, toolUseId: part.id, input: {} } })
    } else if (part.type === 'tool-call') {
      input.emit({ kind: 'agent_event', event: { type: 'tool_start', toolName: part.toolName, toolUseId: part.toolCallId, input: toolInput(part.input) } })
    } else if (part.type === 'tool-result') {
      input.emit({ kind: 'agent_event', event: {
        type: 'tool_result', toolName: part.toolName, toolUseId: part.toolCallId, input: toolInput(part.input),
        result: toolOutput(part.output), isError: false,
      } })
    } else if (part.type === 'tool-error') {
      input.emit({ kind: 'agent_event', event: {
        type: 'tool_result', toolName: part.toolName, toolUseId: part.toolCallId, input: toolInput(part.input),
        result: errorMessage(part.error), isError: true,
      } })
    } else if (part.type === 'error') {
      providerStreamError = part.error
      input.emit({ kind: 'agent_event', event: { type: 'error', message: describeProviderError(part.error) } })
    }
  } } catch (error) { throw new Error(describeProviderError(error)) }

  if (providerStreamError) throw new Error(describeProviderError(providerStreamError))

  const usage = await result.usage
  input.emit({
    kind: 'agent_event',
    event: {
      type: 'complete',
      stopReason: 'end_turn',
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
        cacheCreationTokens: usage.inputTokenDetails.cacheWriteTokens,
      },
    },
  })

  return [{
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
      model: input.modelId,
      stop_reason: 'end_turn',
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens ?? 0,
        cache_read_input_tokens: usage.inputTokenDetails.cacheReadTokens,
        cache_creation_input_tokens: usage.inputTokenDetails.cacheWriteTokens,
      },
    },
    parent_tool_use_id: null,
    session_id: input.session.sessionId,
  }]
}

function createPromptWithHistory(history: SDKMessage[], prompt: string): string {
  const transcript = history
    .map((message) => {
      const text = getMessageText(message)
      if (!text) return ''
      return message.type === 'assistant' ? `Assistant:\n${text}` : `User:\n${text}`
    })
    .filter(Boolean)
    .join('\n\n')
  return transcript ? `${transcript}\n\nUser:\n${prompt}` : prompt
}

function getMessageText(message: SDKMessage): string {
  if (!isRecord(message) || !isRecord(message.message)) return ''
  return readTextBlocks(message.message.content)
}

function readTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toolInput(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value }
}

function toolOutput(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeProviderError(error: unknown): string {
  if (!isRecord(error)) return errorMessage(error)
  const status = typeof error.statusCode === 'number' ? ` status=${error.statusCode}` : ''
  const url = typeof error.url === 'string' ? ` url=${error.url}` : ''
  const body = typeof error.responseBody === 'string' ? ` body=${error.responseBody.slice(0, 2_000)}` : ''
  return `${errorMessage(error)}${status}${url}${body}`
}

interface PendingPermissionInput {
  toolName: string
  toolInput: Record<string, unknown>
  description: string
  dangerLevel: PermissionRequest['dangerLevel']
}

async function assertPermissionApproved(input: Parameters<AgentRuntimeWebAgentTurnRunner>[0], pending: PendingPermissionInput): Promise<void> {
  if (input.permissionMode === 'bypassPermissions') return
  if (!input.interactionStore) throw new Error('当前服务未配置权限审批存储，无法写入文件')
  const requestId = crypto.randomUUID()
  const request: PermissionRequest = {
    requestId, sessionId: input.session.sessionId, ...pending,
  }
  await input.interactionStore.createInteraction({ ...input.scope, taskId: input.taskId, kind: 'permission', request, expiresAt: Date.now() + 10 * 60_000 })
  const response = await waitForPermission(input, requestId)
  if (response.behavior !== 'allow') throw new Error(`用户拒绝操作: ${pending.description}`)
}

async function waitForPermission(input: Parameters<AgentRuntimeWebAgentTurnRunner>[0], requestId: string): Promise<PermissionResponse> {
  while (!input.signal.aborted) {
    const record = await input.interactionStore?.getInteraction(input.scope, requestId)
    if (!record) throw new Error('权限请求不存在')
    if (record.status === 'resolved' && record.response && 'behavior' in record.response) return record.response as PermissionResponse
    if (record.status !== 'pending') throw new Error('权限请求已取消或超时')
    await Bun.sleep(250)
  }
  throw new Error('任务已取消')
}

async function askUser(input: Parameters<AgentRuntimeWebAgentTurnRunner>[0], questions: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }> }>): Promise<Record<string, string>> {
  if (!input.interactionStore) throw new Error('当前服务未配置 AskUser 交互存储')
  const requestId = crypto.randomUUID()
  const request: AskUserRequest = { requestId, sessionId: input.session.sessionId, toolInput: { questions }, questions: questions.map((question) => ({ ...question, options: question.options ?? [] })) }
  await input.interactionStore.createInteraction({ ...input.scope, taskId: input.taskId, kind: 'ask_user', request, expiresAt: Date.now() + 10 * 60_000 })
  while (!input.signal.aborted) {
    const record = await input.interactionStore.getInteraction(input.scope, requestId)
    if (record?.status === 'resolved' && record.response && 'answers' in record.response) return (record.response as AskUserResponse).answers
    if (!record || record.status !== 'pending') throw new Error('用户问答已取消或超时')
    await Bun.sleep(250)
  }
  throw new Error('任务已取消')
}

async function assertPlanApproved(input: Parameters<AgentRuntimeWebAgentTurnRunner>[0], plan: string): Promise<void> {
  await assertPermissionApproved(input, {
    toolName: 'ExitPlanMode',
    toolInput: { plan },
    description: '批准计划并允许后续高风险操作',
    dangerLevel: 'dangerous',
  })
}
