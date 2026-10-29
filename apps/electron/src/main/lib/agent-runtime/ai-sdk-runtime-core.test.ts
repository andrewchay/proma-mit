import { describe, expect, mock, test } from 'bun:test'
import { buildElectronMock } from '../testing/electron-mock'
import type { RuntimeToolDefinition } from './types'
import { bindAISDKSessionIdentity, revokeAISDKSessionIdentity } from './ai-sdk-session-identity'
import type { AISDKRuntimeSessionState, AISDKToolExecutionState, ExecutedAISDKToolResult } from './ai-sdk-runtime-core'


mock.module('electron', () => buildElectronMock())

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

function createBoundTools(core: InstanceType<typeof AISDKRuntimeCore>, tools: RuntimeToolDefinition[], state: AISDKToolExecutionState) {
  bindAISDKSessionIdentity(state.activeSession, state.sessionId, state.cwd)
  return core.createAISDKTools(tools, state)
}

describe('AI SDK runtime core', () => {
  test('Given 会话身份已撤销 When 旧工具调用或重新绑定 Then 拒绝执行', async () => {
    const core = new AISDKRuntimeCore()
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'bypassPermissions', planModeEntered: false }
    let calls = 0
    const tools = createBoundTools(core, [createRuntimeTool('BoundRead', async () => { calls += 1; return { toolCallId: '', content: 'ok' } })], {
      sessionId: 'revoked-session', cwd: '/tmp', signal: activeSession.controller.signal, activeSession,
    })
    revokeAISDKSessionIdentity(activeSession)
    const tool = tools.BoundRead as unknown as ExecutableAITool
    expect((await tool.execute({}, { toolCallId: 'x', messages: [], context: {} })).isError).toBe(true)
    expect(calls).toBe(0)
    expect(() => bindAISDKSessionIdentity(activeSession, 'revoked-session', '/tmp')).toThrow()
  })

  test('Given 活动会话已绑定 When 使用其他会话或目录创建工具集 Then 执行被拒绝', async () => {
    const core = new AISDKRuntimeCore()
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'bypassPermissions', planModeEntered: false }
    bindAISDKSessionIdentity(activeSession, 'real-session', '/tmp/real')
    let calls = 0
    const definition = createRuntimeTool('BoundRead', async () => { calls += 1; return { toolCallId: '', content: 'ok' } })
    for (const state of [{ sessionId: 'other-session', cwd: '/tmp/real' }, { sessionId: 'real-session', cwd: '/tmp/other' }]) {
      const tools = core.createAISDKTools([definition], { ...state, signal: activeSession.controller.signal, activeSession })
      const tool = tools.BoundRead as unknown as ExecutableAITool
      const result = await tool.execute({}, { toolCallId: 'x', messages: [], context: {} })
      expect(result.isError).toBe(true)
    }
    expect(calls).toBe(0)
  })

  test('Given 活动会话未绑定 When 执行工具 Then 默认拒绝', async () => {
    const core = new AISDKRuntimeCore()
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'bypassPermissions', planModeEntered: false }
    let calls = 0
    const tools = core.createAISDKTools([createRuntimeTool('BoundRead', async () => { calls += 1; return { toolCallId: '', content: 'ok' } })], {
      sessionId: 'unbound', cwd: '/tmp', signal: activeSession.controller.signal, activeSession,
    })
    const tool = tools.BoundRead as unknown as ExecutableAITool
    expect((await tool.execute({}, { toolCallId: 'x', messages: [], context: {} })).isError).toBe(true)
    expect(calls).toBe(0)
  })

  test('Given 活动会话已绑定 When 尝试重新绑定 Then 拒绝改写', () => {
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'safe', planModeEntered: false }
    bindAISDKSessionIdentity(activeSession, 'real-session', '/tmp/real')
    expect(() => bindAISDKSessionIdentity(activeSession, 'other-session', '/tmp/real')).toThrow()
  })

  test('Given 工具集已绑定会话 When 调用方改写状态 Then 工具仍使用初始身份和工作目录', async () => {
    const core = new AISDKRuntimeCore()
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'bypassPermissions', planModeEntered: false }
    const state: AISDKToolExecutionState = { sessionId: 'bound-session', cwd: '/tmp/bound', signal: activeSession.controller.signal, activeSession }
    let observed: { sessionId: string; cwd: string; frozen: boolean } | undefined
    const tools = createBoundTools(core, [createRuntimeTool('BoundRead', async (_input, ctx) => {
      observed = { sessionId: ctx.sessionId, cwd: ctx.cwd, frozen: Object.isFrozen(ctx) }
      return { toolCallId: '', content: 'ok' }
    })], state)
    state.sessionId = 'other-session'
    state.cwd = '/tmp/other'
    const tool = tools.BoundRead as unknown as ExecutableAITool
    const result = await tool.execute({}, { toolCallId: 'x', messages: [], context: {} })
    expect(result.isError).toBeFalsy()
    expect(observed).toEqual({ sessionId: 'bound-session', cwd: '/tmp/bound', frozen: true })
  })

  test('Given 计划审批期间会话停止 When 审批返回 Then 不切换权限模式', async () => {
    const core = new AISDKRuntimeCore()
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'plan', planModeEntered: true }
    const tools = createBoundTools(core, [createRuntimeTool('ExitPlanMode', async () => ({ toolCallId: '', content: 'unexpected' }))], {
      sessionId: 'abort-plan', cwd: '/tmp', signal: activeSession.controller.signal, activeSession,
      onExitPlanMode: async () => { activeSession.controller.abort(); return { behavior: 'allow', targetMode: 'bypassPermissions' } },
    })
    const tool = tools.ExitPlanMode as unknown as ExecutableAITool
    const result = await tool.execute({}, { toolCallId: 'x', messages: [], context: {}, abortSignal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(activeSession.permissionMode).toBe('plan')
  })

  test('Given 问答期间会话停止 When 用户回答 Then 不返回回答内容', async () => {
    const core = new AISDKRuntimeCore()
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'safe', planModeEntered: false }
    const tools = createBoundTools(core, [createRuntimeTool('AskUserQuestion', async () => ({ toolCallId: '', content: 'unexpected' }))], {
      sessionId: 'abort-ask', cwd: '/tmp', signal: activeSession.controller.signal, activeSession,
      onAskUser: async () => { activeSession.controller.abort(); return { behavior: 'allow', answers: { question: 'private answer' } } },
    })
    const tool = tools.AskUserQuestion as unknown as ExecutableAITool
    const result = await tool.execute({}, { toolCallId: 'x', messages: [], context: {}, abortSignal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('private answer')
  })

  test('Given 会话已停止但工具级 signal 未取消 When 执行 Then 不调用工具', async () => {
    const core = new AISDKRuntimeCore()
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'bypassPermissions', planModeEntered: false }
    let calls = 0
    const tools = createBoundTools(core, [createRuntimeTool('BoundRead', async () => { calls += 1; return { toolCallId: '', content: 'ok' } })], {
      sessionId: 'aborted-session', cwd: '/tmp', signal: activeSession.controller.signal, activeSession,
    })
    activeSession.controller.abort()
    const tool = tools.BoundRead as unknown as ExecutableAITool
    const result = await tool.execute({}, { toolCallId: 'x', messages: [], context: {}, abortSignal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(calls).toBe(0)
  })

  test('Given 审批期间会话停止 When 工具级 signal 未取消 Then 不调用工具', async () => {
    const core = new AISDKRuntimeCore()
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'safe', planModeEntered: false, ownerActionApproval: true }
    let calls = 0
    const tools = createBoundTools(core, [createRuntimeTool('SendExternalMessage', async () => { calls += 1; return { toolCallId: '', content: 'ok' } })], {
      sessionId: 'abort-during-approval', cwd: '/tmp', signal: activeSession.controller.signal, activeSession,
      canUseTool: async () => { activeSession.controller.abort(); return { allowed: true } },
    })
    const tool = tools.SendExternalMessage as unknown as ExecutableAITool
    const result = await tool.execute({}, { toolCallId: 'x', messages: [], context: {}, abortSignal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(calls).toBe(0)
  })

  test('Given 隔离写入标记在绑定后变化 When 执行 Then 失败关闭', async () => {
    const core = new AISDKRuntimeCore()
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'safe', planModeEntered: false, worktreeScopedWrite: false }
    let executed = false
    const tools = createBoundTools(core, [createRuntimeTool('Write', async () => { executed = true; return { toolCallId: '', content: 'ok' } })], {
      sessionId: 'scoped-session', cwd: '/tmp', signal: activeSession.controller.signal, activeSession,
    })
    activeSession.worktreeScopedWrite = true
    const tool = tools.Write as unknown as ExecutableAITool
    const result = await tool.execute({ file_path: '/tmp/a' }, { toolCallId: 'x', messages: [], context: {} })
    expect(result.isError).toBe(true)
    expect(executed).toBe(false)
  })

  test('Given 审批等待期间 Owner 标记变化 When 审批返回 Then 不执行工具', async () => {
    const core = new AISDKRuntimeCore()
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'safe', planModeEntered: false, ownerActionApproval: true }
    let executed = false
    const tools = createBoundTools(core, [createRuntimeTool('SendExternalMessage', async () => { executed = true; return { toolCallId: '', content: 'ok' } })], {
      sessionId: 'owner-approval-drift', cwd: '/tmp', signal: activeSession.controller.signal, activeSession,
      canUseTool: async () => { activeSession.ownerActionApproval = false; return { allowed: true } },
    })
    const tool = tools.SendExternalMessage as unknown as ExecutableAITool
    const result = await tool.execute({}, { toolCallId: 'x', messages: [], context: {} })
    expect(result.isError).toBe(true)
    expect(executed).toBe(false)
  })

  test('Given Owner 标记在绑定后变化 When 执行 Then 失败关闭', async () => {
    const core = new AISDKRuntimeCore()
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'bypassPermissions', planModeEntered: false, ownerActionApproval: true }
    let executed = false
    const tools = createBoundTools(core, [createRuntimeTool('BoundRead', async () => { executed = true; return { toolCallId: '', content: 'ok' } })], {
      sessionId: 'owner-session', cwd: '/tmp', signal: activeSession.controller.signal, activeSession,
    })
    activeSession.ownerActionApproval = false
    const tool = tools.BoundRead as unknown as ExecutableAITool
    const result = await tool.execute({}, { toolCallId: 'x', messages: [], context: {} })
    expect(result.isError).toBe(true)
    expect(executed).toBe(false)
  })

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

    const toolSet = createBoundTools(core, [writeTool], {
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

  test('Given Owner safe运行模式 When尝试外发类工具 Then执行前拒绝且外部动作零调用', async () => {
    const core = new AISDKRuntimeCore()
    let sendCalls = 0
    const sendTool = createRuntimeTool('SendExternalMessage', async () => {
      sendCalls += 1
      return { toolCallId: 'unexpected', content: '不应发送' }
    })
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'safe', planModeEntered: false }
    const toolSet = createBoundTools(core, [sendTool], {
      sessionId: 'owner-external-send-denied', cwd: '/tmp', signal: activeSession.controller.signal, activeSession,
    })
    const send = toolSet.SendExternalMessage as unknown as ExecutableAITool
    const result = await send.execute({ recipient: 'external', body: 'fixture' }, {
      toolCallId: 'send-1', messages: [], abortSignal: activeSession.controller.signal, context: {},
    })
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('安全模式下不允许执行写操作')
    expect(sendCalls).toBe(0)
  })

  test('Given 专用Owner动作审批 When拒绝外发提案 Then请求审批但不执行外部动作', async () => {
    const core = new AISDKRuntimeCore()
    let sendCalls = 0
    let approvalCalls = 0
    const sendTool = createRuntimeTool('SendExternalMessage', async () => {
      sendCalls += 1
      return { toolCallId: 'unexpected', content: '不应发送' }
    })
    const activeSession: AISDKRuntimeSessionState = {
      controller: new AbortController(), permissionMode: 'safe', planModeEntered: false, ownerActionApproval: true,
    }
    const toolSet = createBoundTools(core, [sendTool], {
      sessionId: 'owner-action-denied', cwd: '/tmp', signal: activeSession.controller.signal, activeSession,
      canUseTool: async (toolName, input) => {
        approvalCalls += 1
        expect(toolName).toBe('SendExternalMessage')
        expect(input).toEqual({ recipient: 'external', body: 'fixture' })
        return { allowed: false, message: '用户拒绝了此操作' }
      },
    })
    const send = toolSet.SendExternalMessage as unknown as ExecutableAITool
    const result = await send.execute({ recipient: 'external', body: 'fixture' }, {
      toolCallId: 'send-owner-denied', messages: [], abortSignal: activeSession.controller.signal, context: {},
    })
    expect(result.isError).toBe(true)
    expect(approvalCalls).toBe(1)
    expect(sendCalls).toBe(0)
  })

  test('Given 专用Owner动作审批 When精确外发动作获本次允许 Then只执行该动作一次', async () => {
    const core = new AISDKRuntimeCore()
    const sent: string[] = []
    const sendTool = createRuntimeTool('SendExternalMessage', async (input) => {
      sent.push(JSON.stringify(input))
      return { toolCallId: 'sent', content: '已发送' }
    })
    const activeSession: AISDKRuntimeSessionState = {
      controller: new AbortController(), permissionMode: 'safe', planModeEntered: false, ownerActionApproval: true,
    }
    const toolSet = createBoundTools(core, [sendTool], {
      sessionId: 'owner-action-allowed', cwd: '/tmp', signal: activeSession.controller.signal, activeSession,
      canUseTool: async () => ({ allowed: true }),
    })
    const send = toolSet.SendExternalMessage as unknown as ExecutableAITool
    const result = await send.execute({ recipient: 'external', body: 'fixture' }, {
      toolCallId: 'send-owner-allowed', messages: [], abortSignal: activeSession.controller.signal, context: {},
    })
    expect(result.isError).toBeFalsy()
    expect(sent).toEqual(['{"recipient":"external","body":"fixture"}'])
  })

  test('given a screenshot result when converting tool output then the model receives an image file block and readable fallback', async () => {
    const core = new AISDKRuntimeCore()
    const screenshotTool = createRuntimeTool('ComputerUseScreenshot', async () => ({
      toolCallId: 'tool-1',
      content: '截图已附加。结构化页面快照：{"title":"Agent Loop"}',
      imageData: [{ mediaType: 'image/png', data: 'AQID' }],
    }))
    const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'bypassPermissions', planModeEntered: false }
    const toolSet = createBoundTools(core, [screenshotTool], { sessionId: 'session-1', cwd: '/tmp', signal: activeSession.controller.signal, activeSession })
    const screenshot = toolSet.ComputerUseScreenshot as unknown as ExecutableAITool
    const result = await screenshot.execute({}, { toolCallId: 'tool-1', messages: [], abortSignal: activeSession.controller.signal, context: {} })

    expect(screenshot.toModelOutput({ output: result })).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: '截图已附加。结构化页面快照：{"title":"Agent Loop"}' },
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
    const toolSet = createBoundTools(core, [checkpointTool], {
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

  test('given safe dev session with worktreeScopedWrite when Write targets inside cwd then allowed; outside cwd or without flag then denied', async () => {
    const core = new AISDKRuntimeCore()
    const writes: string[] = []
    const writeTool = createRuntimeTool('Write', async (input) => {
      writes.push(String((input as Record<string, unknown>).file_path))
      return { toolCallId: 'unexpected', content: '不应执行占位实现' }
    })
    const toolSet = createBoundTools(core, [writeTool], {
      sessionId: 'session-safe-dev',
      cwd: '/tmp/worktree/source',
      signal: new AbortController().signal,
      activeSession: {
        controller: new AbortController(), permissionMode: 'safe', planModeEntered: false,
        worktreeScopedWrite: true,
      },
    })
    const write = toolSet.Write as unknown as ExecutableAITool

    // 相对路径落在 cwd 内 → 放行
    const inside = await write.execute({ file_path: 'hello.txt', content: 'x' },
      { toolCallId: 'w1', messages: [], abortSignal: new AbortController().signal, context: {} })
    expect(inside.isError).toBeFalsy()

    // 越界（相对路径回溯 / 绝对路径在外）→ 拒绝且不执行
    for (const file_path of ['../escape.txt', '/etc/passwd', 'a/../../b.txt']) {
      const denied = await write.execute({ file_path, content: 'x' },
        { toolCallId: 'w2', messages: [], abortSignal: new AbortController().signal, context: {} })
      expect(denied.isError).toBe(true)
      expect(String(denied.content)).toContain('工作树内')
    }
    expect(writes).toEqual(['hello.txt'])

    // 未置位豁免的普通 safe 会话：Write 仍被拒
    const plainToolSet = createBoundTools(core, [writeTool], {
      sessionId: 'session-safe-plain',
      cwd: '/tmp/worktree/source',
      signal: new AbortController().signal,
      activeSession: { controller: new AbortController(), permissionMode: 'safe', planModeEntered: false },
    })
    const plainWrite = plainToolSet.Write as unknown as ExecutableAITool
    const denied = await plainWrite.execute({ file_path: 'hello.txt', content: 'x' },
      { toolCallId: 'w3', messages: [], abortSignal: new AbortController().signal, context: {} })
    expect(denied.isError).toBe(true)
    expect(String(denied.content)).toContain('安全模式下不允许执行写操作')
  })
})
