import { describe, expect, test } from 'bun:test'
import {
  createPiToolBridge,
  PI_PROMA_BASH_TOOL_NAME,
  PI_PROMA_AGENT_TOOL_NAME,
  PI_PROMA_ASK_USER_TOOL_NAME,
  PI_PROMA_EDIT_TOOL_NAME,
  PI_PROMA_ENTER_PLAN_MODE_TOOL_NAME,
  PI_PROMA_EXIT_PLAN_MODE_TOOL_NAME,
  PI_PROMA_GREP_TOOL_NAME,
  PI_PROMA_GOAL_CHECKPOINT_TOOL_NAME,
  PI_PROMA_READ_TOOL_NAME,
  PI_PROMA_WRITE_TOOL_NAME,
  PI_RUNTIME_TOOL_CAPABILITIES,
} from './pi-tool-bridge'
import type { RuntimeToolDefinition } from '../agent-runtime/types'

function createReadTool(execute: RuntimeToolDefinition['execute']): RuntimeToolDefinition {
  return {
    name: 'Read',
    description: '读取文件',
    parameters: { type: 'object', properties: {}, required: [] },
    execute,
  }
}

function createCoreTools(readExecute: RuntimeToolDefinition['execute']): RuntimeToolDefinition[] {
  const placeholder = async (): Promise<{ toolCallId: string; content: string; isError: boolean }> => ({
    toolCallId: '', content: 'ok', isError: false,
  })
  return [
    createReadTool(readExecute),
    { name: 'Write', description: '写入文件', parameters: { type: 'object', properties: {}, required: [] }, execute: placeholder },
    { name: 'Edit', description: '编辑文件', parameters: { type: 'object', properties: {}, required: [] }, execute: placeholder },
    { name: 'Grep', description: '搜索文件', parameters: { type: 'object', properties: {}, required: [] }, execute: placeholder },
    { name: 'Bash', description: '执行命令', parameters: { type: 'object', properties: {}, required: [] }, execute: placeholder },
    { name: 'EnterPlanMode', description: '进入计划模式', parameters: { type: 'object', properties: {}, required: [] }, execute: placeholder },
    { name: 'ExitPlanMode', description: '退出计划模式', parameters: { type: 'object', properties: {}, required: [] }, execute: placeholder },
    { name: 'AskUserQuestion', description: '向用户提问', parameters: { type: 'object', properties: {}, required: [] }, execute: placeholder },
    { name: 'Agent', description: '委派子代理', parameters: { type: 'object', properties: {}, required: [] }, execute: placeholder },
    { name: 'GoalCheckpoint', description: '提交 Goal 检查点', parameters: { type: 'object', properties: {}, required: [] }, execute: placeholder },
  ]
}

describe('Pi Tool Bridge', () => {
  test('given P0 bridge when tools are registered then only Proma read is exposed', () => {
    const tools = createPiToolBridge({
      toolContext: { cwd: '/workspace', sessionId: 'pi-p0' },
      canUseTool: async () => ({ allowed: true }),
      coreTools: createCoreTools(async () => ({ toolCallId: '', content: 'ok', isError: false })),
    })

    expect(PI_RUNTIME_TOOL_CAPABILITIES.read).toBe(true)
    expect(PI_RUNTIME_TOOL_CAPABILITIES.shell).toBe(true)
    expect(tools.map((tool) => tool.name)).toEqual([
      PI_PROMA_READ_TOOL_NAME,
      PI_PROMA_WRITE_TOOL_NAME,
      PI_PROMA_EDIT_TOOL_NAME,
      PI_PROMA_GREP_TOOL_NAME,
      PI_PROMA_BASH_TOOL_NAME,
      PI_PROMA_ENTER_PLAN_MODE_TOOL_NAME,
      PI_PROMA_EXIT_PLAN_MODE_TOOL_NAME,
      PI_PROMA_ASK_USER_TOOL_NAME,
      PI_PROMA_AGENT_TOOL_NAME,
    ])
    expect(tools.some((tool) => tool.name === 'bash')).toBe(false)
  })

  test('given Proma allows read when Pi invokes bridge then it delegates to canonical Read', async () => {
    const calls: string[] = []
    const tools = createPiToolBridge({
      toolContext: { cwd: '/workspace', sessionId: 'pi-p0' },
      canUseTool: async (toolName, input) => {
        calls.push(`${toolName}:${String(input.file_path)}`)
        return { allowed: true }
      },
      coreTools: createCoreTools(async (input) => ({
        toolCallId: '',
        content: `内容:${String((input as { file_path: string }).file_path)}`,
        isError: false,
      })),
    })

    const readTool = tools[0]
    if (!readTool) throw new Error('缺少 Proma Read 工具')
    const result = await readTool.execute('call-1', { file_path: 'notes.txt' }, undefined, undefined, {} as never)

    expect(calls).toEqual(['Read:notes.txt'])
    expect(result.content).toEqual([{ type: 'text', text: '内容:notes.txt' }])
    expect(result.details).toEqual({ toolName: 'Read', isError: false })
  })

  test('given Proma denies read when Pi invokes bridge then the runtime tool is not executed', async () => {
    let executed = false
    const tools = createPiToolBridge({
      toolContext: { cwd: '/workspace', sessionId: 'pi-p0' },
      canUseTool: async () => ({ allowed: false, message: '权限拒绝' }),
      coreTools: createCoreTools(async () => {
        executed = true
        return { toolCallId: '', content: 'unexpected', isError: false }
      }),
    })

    const readTool = tools[0]
    if (!readTool) throw new Error('缺少 Proma Read 工具')
    const result = await readTool.execute('call-2', { file_path: 'private.txt' }, undefined, undefined, {} as never)

    expect(executed).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: '权限拒绝' }])
    expect(result.details).toEqual({ toolName: 'Read', isError: true })
  })

  test('given safe policy denies write when Pi invokes bridge then no file tool runs', async () => {
    let writeExecuted = false
    const tools = createPiToolBridge({
      toolContext: { cwd: '/workspace', sessionId: 'pi-p1', permissionMode: 'safe' },
      canUseTool: async (toolName) => ({
        allowed: toolName === 'Read' || toolName === 'Grep',
        message: '安全模式下不允许执行写操作',
      }),
      coreTools: createCoreTools(async () => ({ toolCallId: '', content: 'ok', isError: false })).map((tool) => (
        tool.name === 'Write'
          ? { ...tool, execute: async () => { writeExecuted = true; return { toolCallId: '', content: 'unexpected', isError: false } } }
          : tool
      )),
    })

    const writeTool = tools.find((tool) => tool.name === PI_PROMA_WRITE_TOOL_NAME)
    if (!writeTool) throw new Error('缺少 Proma Write 工具')
    const result = await writeTool.execute('call-safe', { file_path: 'note.txt', content: 'private' }, undefined, undefined, {} as never)

    expect(writeExecuted).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: '安全模式下不允许执行写操作' }])
  })

  test('given Pi enters and exits plan mode then it uses the Proma interaction callbacks', async () => {
    let entered = 0
    let selectedMode = ''
    const tools = createPiToolBridge({
      toolContext: {
        cwd: '/workspace',
        sessionId: 'pi-p2',
        onEnterPlanMode: () => { entered += 1 },
        onExitPlanMode: async () => ({ behavior: 'allow', targetMode: 'auto' }),
        setPermissionMode: (mode) => { selectedMode = mode },
      },
      canUseTool: async () => ({ allowed: true }),
      coreTools: createCoreTools(async () => ({ toolCallId: '', content: 'ok', isError: false })),
    })

    const enterTool = tools.find((tool) => tool.name === PI_PROMA_ENTER_PLAN_MODE_TOOL_NAME)
    const exitTool = tools.find((tool) => tool.name === PI_PROMA_EXIT_PLAN_MODE_TOOL_NAME)
    if (!enterTool || !exitTool) throw new Error('缺少 Plan 工具')
    await enterTool.execute('plan-enter', {}, undefined, undefined, {} as never)
    await exitTool.execute('plan-exit', { summary: '实施方案' }, undefined, undefined, {} as never)

    expect(entered).toBe(1)
    expect(selectedMode).toBe('auto')
  })

  test('given an active Goal when Pi tools are registered then GoalCheckpoint is exposed and persists the checkpoint', async () => {
    const checkpoints: unknown[] = []
    let permissionChecks = 0
    const tools = createPiToolBridge({
      toolContext: {
        cwd: '/workspace',
        sessionId: 'pi-goal',
        onGoalCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint) },
      },
      canUseTool: async () => {
        permissionChecks += 1
        return { allowed: false, message: 'Goal 控制面不应请求权限' }
      },
      coreTools: createCoreTools(async () => ({ toolCallId: '', content: 'ok', isError: false })),
    })

    const checkpointTool = tools.find((tool) => tool.name === PI_PROMA_GOAL_CHECKPOINT_TOOL_NAME)
    if (!checkpointTool) throw new Error('缺少 Pi GoalCheckpoint 工具')
    const result = await checkpointTool.execute('goal-1', {
      outcome: 'continue', summary: '已完成第一步', completed: ['第一步'], evidence: [{ kind: 'test', value: '通过' }], nextAction: '继续',
    }, undefined, undefined, {} as never)

    expect(checkpoints).toHaveLength(1)
    expect(permissionChecks).toBe(0)
    expect(result.details).toEqual({ toolName: 'GoalCheckpoint', isError: false })
  })

  test('given a screenshot result when Pi invokes the bridge then the next Pi turn receives the image body', async () => {
    const tools = createPiToolBridge({
      toolContext: { cwd: '/workspace', sessionId: 'pi-screenshot' },
      canUseTool: async () => ({ allowed: true }),
      coreTools: [
        ...createCoreTools(async () => ({ toolCallId: '', content: 'ok', isError: false })),
        {
          name: 'WebBridgeScreenshot',
          description: '网页截图',
          parameters: { type: 'object', properties: {}, required: [] },
          execute: async () => ({ toolCallId: '', content: '截图已附加', imageData: [{ mediaType: 'image/png', data: 'AQID' }] }),
        },
      ],
    })

    const screenshotTool = tools.find((tool) => tool.name === 'WebBridgeScreenshot')
    if (!screenshotTool) throw new Error('缺少 WebBridgeScreenshot 工具')
    const result = await screenshotTool.execute('screenshot-1', {}, undefined, undefined, {} as never)

    expect(result.content).toEqual([
      { type: 'text', text: '截图已附加' },
      { type: 'image', mimeType: 'image/png', data: 'AQID' },
    ])
  })
})
