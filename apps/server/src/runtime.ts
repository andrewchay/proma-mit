import { createAgentAISDKModel } from '@proma/core/providers/ai-sdk-bridge'
import type { SDKMessage } from '@proma/shared'
import type { AgentRuntimeWebAgentTurnRunner } from '@proma/shared/utils'
import { AGENT_PROVIDER_RUNTIME_CAPABILITIES, resolveAgentRuntimeBaseUrl } from '@proma/shared'
import { generateText, isStepCount, jsonSchema, streamText, tool } from 'ai'
import { createWorkspaceReadTools } from './workspace-tools.ts'
import { createWorkspaceWriteTool, writeWorkspaceFile } from './workspace-tools.ts'
import { createServerMcpToolSet } from './server-mcp-tools.ts'
import type { AskUserRequest, AskUserResponse, ExitPlanModeRequest, ExitPlanModeResponse, PermissionRequest, PermissionResponse } from '@proma/shared'

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
  const readTools = createWorkspaceReadTools(input.workspace.cwd)
  const isolatedCommand = input.executeIsolatedCommand
  const interactionTools = {
    AskUserQuestion: tool({
      description: '向用户提出需要选择的问题，并等待回答。',
      inputSchema: jsonSchema<{ questions: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }> }> }>({ type: 'object', required: ['questions'], properties: { questions: { type: 'array' } }, additionalProperties: false }),
      execute: async ({ questions }) => JSON.stringify(await askUser(input, questions)),
    }),
    EnterPlanMode: tool({ description: '进入只规划、不执行写操作的模式。', inputSchema: jsonSchema<Record<string, never>>({ type: 'object', additionalProperties: false }), execute: async () => '当前回合已按 Plan 模式运行；请给出可审批计划。' }),
    ExitPlanMode: tool({ description: '请求用户批准计划。批准后应由用户发起新的执行回合。', inputSchema: jsonSchema<{ plan: string }>({ type: 'object', required: ['plan'], properties: { plan: { type: 'string' } }, additionalProperties: false }), execute: async ({ plan }) => {
      const decision = await requestPlanDecision(input, plan)
      return decision.message
    } }),
  }
  const mutableTools = input.permissionMode === 'plan' ? {} : {
    DelegateSubAgent: tool({
      description: '在独立上下文中委派只读研究任务；不会继承父会话历史或写入能力。',
      inputSchema: jsonSchema<{ task: string; agentName?: string }>({ type:'object', required:['task'], properties:{ task:{type:'string'}, agentName:{type:'string'} }, additionalProperties:false }),
      execute: async ({ task, agentName }) => {
        if (!input.startSubtask) throw new Error('当前服务未配置子代理任务编排器')
        const child = await input.startSubtask({
          task,
          agentName,
          maxOutputTokens: input.subtaskLimits?.maxOutputTokensPerTask ?? 4_000,
          execute: async (signal) => (await generateText({
            model,
            prompt: `你是 ${agentName ?? 'researcher'} 子代理。仅分析并给出简洁结论，不执行写入或外部副作用。\n\n任务：${task}`,
            abortSignal: signal,
            maxOutputTokens: input.subtaskLimits?.maxOutputTokensPerTask ?? 4_000,
          })).text,
        })
        return JSON.stringify({ taskId: child.taskId, output: child.output })
      },
    }),
    ...createWorkspaceWriteTool(input.workspace.cwd, async (path, content) => {
      await assertPermissionApproved(input, {
        toolName: 'WriteWorkspaceFile',
        toolInput: { path, content },
        description: `写入工作区文件 ${path}`,
        dangerLevel: 'normal',
      })
      return writeWorkspaceFile(input.workspace.cwd, path, content)
    }),
    ...createServerMcpToolSet(input, input.mcpTools ?? [], async (toolName, toolInput, description) => {
      await assertPermissionApproved(input, { toolName, toolInput, description, dangerLevel: 'normal' })
    }),
    ...(isolatedCommand ? {
      RunIsolatedCommand: tool({
        description: '在隔离 executor 容器中运行 allowlist 内的命令。该操作需要用户审批。',
        inputSchema: jsonSchema<{ command: string; args?: string[]; timeoutMs?: number }>({
          type: 'object', required: ['command'], properties: {
            command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'number' },
          }, additionalProperties: false,
        }),
        execute: async ({ command, args, timeoutMs }) => {
          const toolInput = { command, args: args ?? [], timeoutMs: timeoutMs ?? 30_000 }
          await assertPermissionApproved(input, {
            toolName: 'RunIsolatedCommand', toolInput,
            description: `在隔离执行器运行 ${command}`,
            dangerLevel: 'dangerous',
          })
          return JSON.stringify(await isolatedCommand({
            taskId: input.taskId,
            workspaceDir: input.workspace.cwd,
            command,
            args: args ?? [],
            timeoutMs: timeoutMs ?? 30_000,
            maxOutputBytes: 256 * 1024,
          }, input.signal))
        },
      }),
    } : {}),
  }
  const result = streamText({
    model,
    prompt: createPromptWithHistory(input.historyMessages, input.prompt),
    abortSignal: input.signal,
    tools: { ...readTools, ...interactionTools, ...mutableTools },
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
  const fingerprint = createPermissionFingerprint(pending)
  if (await input.store?.getPermissionDecision(input.scope, input.session.sessionId, fingerprint, Date.now())) return
  const requestId = crypto.randomUUID()
  const request: PermissionRequest = {
    requestId, sessionId: input.session.sessionId, ...pending,
  }
  await input.interactionStore.createInteraction({ ...input.scope, taskId: input.taskId, kind: 'permission', request, expiresAt: Date.now() + 10 * 60_000 })
  const response = await waitForPermission(input, requestId)
  if (response.behavior !== 'allow') throw new Error(`用户拒绝操作: ${pending.description}`)
  if (response.alwaysAllow && input.store) {
    await input.store.setPermissionDecision({
      ...input.scope,
      sessionId: input.session.sessionId,
      fingerprint,
      expiresAt: Date.now() + 30 * 60_000,
    })
  }
}

function createPermissionFingerprint(pending: PendingPermissionInput): string {
  return JSON.stringify({ toolName: pending.toolName, toolInput: sortRecord(pending.toolInput) })
}

function sortRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
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

async function requestPlanDecision(input: Parameters<AgentRuntimeWebAgentTurnRunner>[0], plan: string): Promise<{ approved: boolean; message: string }> {
  if (!input.interactionStore) throw new Error('当前服务未配置 Plan 审批存储')
  const requestId = crypto.randomUUID()
  const request: ExitPlanModeRequest = {
    requestId,
    sessionId: input.session.sessionId,
    toolInput: { plan },
    allowedPrompts: [],
  }
  await input.interactionStore.createInteraction({ ...input.scope, taskId: input.taskId, kind: 'plan', request, expiresAt: Date.now() + 10 * 60_000 })
  while (!input.signal.aborted) {
    const record = await input.interactionStore.getInteraction(input.scope, requestId)
    if (record?.status === 'resolved' && record.response && 'action' in record.response) {
      const response = record.response as ExitPlanModeResponse
      if (response.action === 'deny') throw new Error('用户拒绝计划')
      if (response.action === 'feedback') return { approved: false, message: `用户要求调整计划：${response.feedback ?? '请重新说明计划'}` }
      if (response.action === 'approve_edit') return { approved: true, message: `用户批准计划，并补充反馈：${response.feedback ?? '无'}。请由用户发起新的执行回合。` }
      return { approved: true, message: '计划已获批准。请由用户发起新的执行回合。' }
    }
    if (!record || record.status !== 'pending') throw new Error('计划审批已取消或超时')
    await Bun.sleep(250)
  }
  throw new Error('任务已取消')
}
