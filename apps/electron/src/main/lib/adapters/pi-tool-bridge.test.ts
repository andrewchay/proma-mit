import { describe, expect, mock, test, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'
import type { RuntimeToolDefinition } from '../agent-runtime/types'

// tool-registry 传递依赖 config-paths / electron；统一使用完整 mock，避免单测进程加载真实 electron。
mock.module('electron', () => buildElectronMock())

// createCoreTools 可能触发插件目录初始化；在 bootstrap 临时配置目录中执行，避免触碰真实 ~/.gravitas。
const originalEnv = { ...process.env }
const bootstrapDir = mkdtempSync(join(tmpdir(), `gravitas-pi-bridge-bootstrap-${process.pid}-`))
process.env.PROMA_TEST_CONFIG_DIR = bootstrapDir

const {
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
} = await import('./pi-tool-bridge')

afterAll(() => {
  process.env = { ...originalEnv }
  rmSync(bootstrapDir, { recursive: true, force: true })
})

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
    { name: 'WebSearch', description: '联网搜索', parameters: { type: 'object', properties: {}, required: [] }, execute: placeholder },
    { name: 'WebFetch', description: '抓取网页', parameters: { type: 'object', properties: {}, required: [] }, execute: placeholder },
    { name: 'RecallMemory', description: '回忆记忆', parameters: { type: 'object', properties: {}, required: [] }, execute: placeholder },
    { name: 'AddMemory', description: '存储记忆', parameters: { type: 'object', properties: {}, required: [] }, execute: placeholder },
    { name: 'SearchProjectMemory', description: '检索本地记忆', parameters: { type: 'object', properties: {}, required: [] }, execute: placeholder },
    { name: 'ReadProjectMemory', description: '读取本地记忆', parameters: { type: 'object', properties: {}, required: [] }, execute: placeholder },
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
      assertToolSession: () => {},
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
      'WebSearch',
      'WebFetch',
      'RecallMemory',
      'AddMemory',
      'SearchProjectMemory',
      'ReadProjectMemory',
      PI_PROMA_ENTER_PLAN_MODE_TOOL_NAME,
      PI_PROMA_EXIT_PLAN_MODE_TOOL_NAME,
      PI_PROMA_ASK_USER_TOOL_NAME,
      PI_PROMA_AGENT_TOOL_NAME,
    ])
    expect(tools.some((tool) => tool.name === 'bash')).toBe(false)
  })

  test('Given Pi 工具集已创建 When 来源上下文被改写 Then 仍使用初始会话与目录', async () => {
    const context = { cwd: '/workspace/original', sessionId: 'pi-original' }
    let seen: { cwd: string; sessionId: string; frozen: boolean } | undefined
    const tools = createPiToolBridge({
      toolContext: context,
      assertToolSession: () => {},
      canUseTool: async () => ({ allowed: true }),
      coreTools: createCoreTools(async (_input, ctx) => {
        seen = { cwd: ctx.cwd, sessionId: ctx.sessionId, frozen: Object.isFrozen(ctx) }
        return { toolCallId: '', content: 'ok', isError: false }
      }),
    })
    context.cwd = '/workspace/other'
    context.sessionId = 'pi-other'
    const read = tools.find((item) => item.name === PI_PROMA_READ_TOOL_NAME)
    if (!read) throw new Error('缺少 Read 工具')
    await read.execute('call-1', { file_path: 'notes.txt' }, undefined, undefined, {} as never)
    expect(seen).toEqual({ cwd: '/workspace/original', sessionId: 'pi-original', frozen: true })
  })

  test('Given Pi 会话已停止但工具 signal 未取消 When 执行 Then 不调用工具', async () => {
    const controller = new AbortController()
    let calls = 0
    const tools = createPiToolBridge({
      toolContext: { cwd: '/workspace', sessionId: 'pi-abort', abortSignal: controller.signal },
      assertToolSession: () => {},
      canUseTool: async () => ({ allowed: true }),
      coreTools: createCoreTools(async () => { calls += 1; return { toolCallId: '', content: 'ok', isError: false } }),
    })
    controller.abort()
    const read = tools.find((item) => item.name === PI_PROMA_READ_TOOL_NAME)
    if (!read) throw new Error('缺少 Read 工具')
    const result = await read.execute('call-1', { file_path: 'notes.txt' }, new AbortController().signal, undefined, {} as never)
    expect(result.details).toMatchObject({ isError: true })
    expect(calls).toBe(0)
  })

  test('Given Pi 审批期间会话停止 When 审批返回 Then 不调用工具', async () => {
    const controller = new AbortController()
    let calls = 0
    const tools = createPiToolBridge({
      toolContext: { cwd: '/workspace', sessionId: 'pi-abort-approval', abortSignal: controller.signal },
      assertToolSession: () => {},
      canUseTool: async () => { controller.abort(); return { allowed: true } },
      coreTools: createCoreTools(async () => { calls += 1; return { toolCallId: '', content: 'ok', isError: false } }),
    })
    const read = tools.find((item) => item.name === PI_PROMA_READ_TOOL_NAME)
    if (!read) throw new Error('缺少 Read 工具')
    const result = await read.execute('call-1', { file_path: 'notes.txt' }, new AbortController().signal, undefined, {} as never)
    expect(result.details).toMatchObject({ isError: true })
    expect(calls).toBe(0)
  })

  test('given Proma allows read when Pi invokes bridge then it delegates to canonical Read', async () => {
    const calls: string[] = []
    const tools = createPiToolBridge({
      toolContext: { cwd: '/workspace', sessionId: 'pi-p0' },
      assertToolSession: () => {},
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
      assertToolSession: () => {},
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
      assertToolSession: () => {},
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
      assertToolSession: () => {},
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
      assertToolSession: () => {},
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
      assertToolSession: () => {},
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

describe('统一撤权入口', () => {
  const coreTools = () => createCoreTools(async () => ({ toolCallId: '', content: 'ok', isError: false }))

  test('Given 未提供会话校验 Within 桥接层 When 任何工具执行 Then 失败关闭', async () => {
    const tools = createPiToolBridge({
      toolContext: { cwd: '/workspace', sessionId: 'pi-nobind' },
      canUseTool: async () => ({ allowed: true }),
      coreTools: coreTools(),
    })
    const read = tools.find((tool) => tool.name === PI_PROMA_READ_TOOL_NAME)
    if (!read) throw new Error('缺少 Read 工具')
    const result = await read.execute('call-1', { file_path: 'notes.txt' }, undefined, undefined, {} as never)
    expect(JSON.stringify(result.content)).toContain('会话身份已失效或被撤销')
  })

  test('Given 会话在校验时被判定撤销 When 执行工具 Then 拒绝且不调用权限回调', async () => {
    let permissionCalls = 0
    const tools = createPiToolBridge({
      toolContext: { cwd: '/workspace', sessionId: 'pi-revoked' },
      assertToolSession: () => { throw new Error('会话身份不匹配，拒绝执行工具') },
      canUseTool: async () => { permissionCalls += 1; return { allowed: true } },
      coreTools: coreTools(),
    })
    const read = tools.find((tool) => tool.name === PI_PROMA_READ_TOOL_NAME)
    if (!read) throw new Error('缺少 Read 工具')
    const result = await read.execute('call-1', { file_path: 'notes.txt' }, undefined, undefined, {} as never)
    expect(JSON.stringify(result.content)).toContain('会话身份已失效或被撤销')
    expect(permissionCalls).toBe(0)
  })

  test('Given 审批通过但等待期间被撤权 When 真正派发 Then 拒绝执行', async () => {
    let checks = 0
    let executed = 0
    const tools = createPiToolBridge({
      toolContext: { cwd: '/workspace', sessionId: 'pi-window' },
      // 第一次通过（判定前），第二次失败（派发前），模拟审批期间的撤权
      assertToolSession: () => { checks += 1; if (checks >= 2) throw new Error('会话已撤销') },
      canUseTool: async () => ({ allowed: true }),
      coreTools: createCoreTools(async () => {
        executed += 1
        return { toolCallId: '', content: 'ok', isError: false }
      }),
    })
    const read = tools.find((tool) => tool.name === PI_PROMA_READ_TOOL_NAME)
    if (!read) throw new Error('缺少 Read 工具')
    const result = await read.execute('call-1', { file_path: 'notes.txt' }, undefined, undefined, {} as never)
    expect(executed).toBe(0)
    expect(checks).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(result.content) + JSON.stringify(result.details)).toContain('会话')
  })

  test('Given GoalCheckpoint 绕过权限回调 When 会话已撤销 Then 不写入检查点', async () => {
    let checkpoints = 0
    const tools = createPiToolBridge({
      toolContext: { cwd: '/workspace', sessionId: 'pi-goal-revoked', onGoalCheckpoint: async () => { checkpoints += 1 } },
      assertToolSession: () => { throw new Error('会话已撤销') },
      canUseTool: async () => ({ allowed: true }),
      coreTools: coreTools(),
    })
    const tool = tools.find((item) => item.name === PI_PROMA_GOAL_CHECKPOINT_TOOL_NAME)
    if (!tool) throw new Error('缺少 GoalCheckpoint 工具')
    await tool.execute('goal-1', { outcome: 'continue', summary: '继续' }, undefined, undefined, {} as never)
    expect(checkpoints).toBe(0)
  })

  test('Given AskUserQuestion 绕过权限回调 When 会话已撤销 Then 不执行交互工具', async () => {
    let asked = 0
    const tools = createPiToolBridge({
      toolContext: { cwd: '/workspace', sessionId: 'pi-ask-revoked', onAskUser: async () => { asked += 1; return { behavior: 'allow', answers: {} } } },
      assertToolSession: () => { throw new Error('会话已撤销') },
      canUseTool: async () => ({ allowed: true }),
      coreTools: coreTools(),
    })
    const tool = tools.find((item) => item.name === PI_PROMA_ASK_USER_TOOL_NAME)
    if (!tool) throw new Error('缺少 AskUser 工具')
    await tool.execute('ask-1', { questions: [{ question: '继续吗', header: '确认', options: [{ label: '是' }] }] }, undefined, undefined, {} as never)
    expect(asked).toBe(0)
  })
})
