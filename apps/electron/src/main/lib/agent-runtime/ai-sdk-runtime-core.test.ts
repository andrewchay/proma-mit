import { describe, expect, mock, test } from 'bun:test'
import type { RuntimeToolDefinition } from './types'
import type { AISDKRuntimeSessionState, ExecutedAISDKToolResult } from './ai-sdk-runtime-core'

mock.module('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class MockBrowserWindow {},
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  nativeImage: { createFromDataURL: () => ({}) },
  desktopCapturer: { getSources: async () => [] },
  screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 1, height: 1 }, bounds: { x: 0, y: 0 }, scaleFactor: 1 }), getAllDisplays: () => [] },
  session: { fromPartition: () => ({ setPermissionRequestHandler: () => undefined }) },
}))

const { AISDKRuntimeCore, buildAISDKMessagesFromSteps, buildAISDKModelMessages } = await import('./ai-sdk-runtime-core')

interface ExecutableAITool {
  execute: (
    input: Record<string, unknown>,
    options: {
      toolCallId: string
      messages: unknown[]
      abortSignal?: AbortSignal
      context: Record<string, never>
    },
  ) => Promise<ExecutedAISDKToolResult>
  toModelOutput: (input: { output: ExecutedAISDKToolResult }) => unknown
}

function createRuntimeTool(name: string, execute: RuntimeToolDefinition['execute']): RuntimeToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parameters: {
      type: 'object',
      properties: {},
    },
    execute,
  }
}

describe('AI SDK runtime core', () => {
  test('given mixed history when building model messages then unsupported roles are filtered', () => {
    const messages = buildAISDKModelMessages([
      { role: 'system', content: 'ignored' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'tool', content: 'ignored tool' },
    ], 'current')

    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'current' },
    ])
  })

  test('given streamed step snapshots when building SDK messages then assistant and tool results are preserved', () => {
    const messages = buildAISDKMessagesFromSteps([{
      text: 'done',
      reasoningText: 'thinking',
      toolCalls: [{
        toolCallId: 'tool-1',
        toolName: 'Read',
        input: { file_path: 'README.md' },
      }],
      toolResults: [{
        toolCallId: 'tool-1',
        toolName: 'Read',
        input: { file_path: 'README.md' },
        output: { content: 'read result' },
      }],
      finishReason: 'tool_use',
    }], 'session-1', 'model-1')

    expect(messages.map((message) => message.type)).toEqual(['assistant', 'user'])
    expect(JSON.stringify(messages[0])).toContain('thinking')
    expect(JSON.stringify(messages[0])).toContain('Read')
    expect(JSON.stringify(messages[1])).toContain('read result')
  })

  test('given safe permission mode when executing write tool then tool execution is denied before runtime tool runs', async () => {
    const core = new AISDKRuntimeCore()
    let executed = false
    const writeTool = createRuntimeTool('Write', async () => {
      executed = true
      return { toolCallId: 'tool-1', content: 'should not run' }
    })
    const activeSession: AISDKRuntimeSessionState = {
      controller: new AbortController(),
      permissionMode: 'safe',
      planModeEntered: false,
    }

    const toolSet = core.createAISDKTools([writeTool], {
      sessionId: 'session-1',
      cwd: '/tmp',
      signal: activeSession.controller.signal,
      activeSession,
    })
    const write = toolSet.Write as unknown as ExecutableAITool
    const result = await write.execute(
      { file_path: 'note.txt', content: 'new' },
      { toolCallId: 'tool-1', messages: [], abortSignal: activeSession.controller.signal, context: {} },
    )

    expect(executed).toBe(false)
    expect(result).toEqual({
      content: '安全模式下不允许执行写操作，请切换到自动审批或完全自动模式',
      isError: true,
    })
  })

  test('given a screenshot result when converting tool output then the model receives an image file block', async () => {
    const core = new AISDKRuntimeCore()
    const screenshotTool = createRuntimeTool('ComputerUseScreenshot', async () => ({
      toolCallId: 'tool-1',
      content: '截图已附加',
      imageData: [{ mediaType: 'image/png', data: 'AQID' }],
    }))
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'bypassPermissions', planModeEntered: false }
    const toolSet = core.createAISDKTools([screenshotTool], { sessionId: 'session-1', cwd: '/tmp', signal: activeSession.controller.signal, activeSession })
    const screenshot = toolSet.ComputerUseScreenshot as unknown as ExecutableAITool
    const result = await screenshot.execute({}, { toolCallId: 'tool-1', messages: [], abortSignal: activeSession.controller.signal, context: {} })

    expect(screenshot.toModelOutput({ output: result })).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: '截图已附加' },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: new Uint8Array([1, 2, 3]) } },
      ],
    })
  })

  test('given an active goal when GoalCheckpoint executes then it bypasses ordinary tool permission and persists through callback', async () => {
    const core = new AISDKRuntimeCore()
    const checkpointTool = createRuntimeTool('GoalCheckpoint', async () => ({
      toolCallId: 'unexpected',
      content: '不应调用占位实现',
    }))
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'safe', planModeEntered: false }
    let checkpointSummary = ''
    const toolSet = core.createAISDKTools([checkpointTool], {
      sessionId: 'session-goal',
      cwd: '/tmp',
      signal: activeSession.controller.signal,
      activeSession,
      onGoalCheckpoint: async (checkpoint) => { checkpointSummary = checkpoint.summary },
    })
    const checkpoint = toolSet.GoalCheckpoint as unknown as ExecutableAITool
    const result = await checkpoint.execute({
      outcome: 'waiting',
      summary: '等待用户授权',
      completed: [],
      evidence: [{ kind: 'tool', value: 'AskUserQuestion' }],
      wakeTrigger: { type: 'user_input' },
    }, { toolCallId: 'goal-1', messages: [], abortSignal: activeSession.controller.signal, context: {} })

    expect(result).toEqual({ content: 'Goal 检查点已持久化。' })
    expect(checkpointSummary).toBe('等待用户授权')
  })
})
