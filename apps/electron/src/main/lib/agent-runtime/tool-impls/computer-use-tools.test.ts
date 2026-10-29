import { describe, expect, mock, test, beforeAll, afterAll, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../../testing/electron-mock'


mock.module('electron', () => buildElectronMock())

const {
  createComputerUseStatusToolDefinition,
  createComputerUseClickToolDefinition,
  createComputerUseMoveToolDefinition,
  createComputerUseDoubleClickToolDefinition,
  createComputerUseDragToolDefinition,
  createComputerUseKeyComboToolDefinition,
  createComputerUseRequestTakeoverToolDefinition,
  executeComputerUseCapabilitiesTool,
  executeComputerUseClickTool,
  executeComputerUseTypeTool,
  executeComputerUseScrollTool,
  executeComputerUseRequestTakeoverTool,
} = await import('./computer-use-tools')

const { computerUseService } = await import('../../computer-use-service')
const directory = mkdtempSync(join(tmpdir(), 'computer-tool-db-')), previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = directory; await (await import('../../project-sqlite-store')).initProjectDb() })
afterAll(async () => {
  (await import('../../project-sqlite-store')).closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

describe('Computer Use 工具', () => {
  test('工具定义将桌面控制标记为显式授权操作', () => {
    expect(createComputerUseStatusToolDefinition().name).toBe('ComputerUseStatus')
    expect(createComputerUseClickToolDefinition().description).toContain('必须向用户')
    expect(createComputerUseMoveToolDefinition().name).toBe('ComputerUseMove')
    expect(createComputerUseDoubleClickToolDefinition().name).toBe('ComputerUseDoubleClick')
    expect(createComputerUseDragToolDefinition().name).toBe('ComputerUseDrag')
    expect(createComputerUseKeyComboToolDefinition().name).toBe('ComputerUseKeyCombo')
    expect(createComputerUseRequestTakeoverToolDefinition().description).toContain('暂停')
  })

  test('Given 普通会话 When 查询桌面能力 Then 进入能力服务', async () => {
    const capabilities = spyOn(computerUseService, 'getCapabilities')
    try {
      const result = await executeComputerUseCapabilitiesTool({}, { cwd: directory, sessionId: 'ordinary-computer-session' })
      expect(result.isError).toBeFalsy()
      expect(capabilities).toHaveBeenCalled()
    } finally { capabilities.mockRestore() }
  })

  test('无效参数不访问系统桌面', async () => {
    const ctx = { cwd: '/tmp', sessionId: 'computer-use-test' }
    const click = await executeComputerUseClickTool({ x: 1 }, ctx)
    const scroll = await executeComputerUseScrollTool({ direction: 'left' }, ctx)
    expect(click.isError).toBe(true)
    expect(scroll.isError).toBe(true)
  })

  test('用户接管明确取消时返回错误', async () => {
    const result = await executeComputerUseRequestTakeoverTool(
      { reason: '需要输入验证码', instruction: '请完成后选择继续' },
      {
        cwd: '/tmp',
        sessionId: 'computer-use-test',
        abortSignal: new AbortController().signal,
        onAskUser: async () => ({ behavior: 'allow', answers: { '完成敏感操作后继续吗？': '取消' } }),
      },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('取消')
  })
})

describe('Computer Use 动作结果分类', () => {
  // 每个用例独立 sessionId：结果未知会登记在执行入口，同会话同指纹会被拦截。
  const baseCtx = { cwd: '/tmp' }

  test('Given 服务超时 When 点击 Then 标记结果未知并禁止自动重试', async () => {
    const ctx = { ...baseCtx, sessionId: 'cu-outcome-timeout' }
    const click = spyOn(computerUseService, 'click').mockImplementation(() => {
      const error = new Error('operation timed out')
      error.name = 'TimeoutError'
      return Promise.reject(error)
    })
    try {
      const result = await executeComputerUseClickTool({ x: 10, y: 20 }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('结果未知')
      expect(result.content).toContain('禁止自动重试')
      expect(result.content).toContain('ComputerUseScreenshot')
    } finally { click.mockRestore() }
  })

  test('Given 服务报权限错误 When 点击 Then 不能推断动作未生效', async () => {
    const ctx = { ...baseCtx, sessionId: 'cu-outcome-denied' }
    const click = spyOn(computerUseService, 'click').mockRejectedValue(Object.assign(new Error('not permitted'), { code: 'EPERM' }))
    try {
      const result = await executeComputerUseClickTool({ x: 10, y: 20 }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('结果未知')
      expect(result.content).not.toContain('未执行')
    } finally { click.mockRestore() }
  })

  test('Given 未知异常 When 输入 Then 保守判为结果未知', async () => {
    const ctx = { ...baseCtx, sessionId: 'cu-outcome-type' }
    const type = spyOn(computerUseService, 'type').mockRejectedValue(new Error('CGEventPost failed'))
    try {
      const result = await executeComputerUseTypeTool({ text: 'hello' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('结果未知')
    } finally { type.mockRestore() }
  })

  test('Given 成功 When 点击 Then 结果标记 applied 且保留原始 message', async () => {
    const ctx = { ...baseCtx, sessionId: 'cu-outcome-success' }
    const click = spyOn(computerUseService, 'click').mockResolvedValue('已点击 (10, 20)')
    try {
      const result = await executeComputerUseClickTool({ x: 10, y: 20 }, ctx)
      expect(result.isError).toBeFalsy()
      expect(result.content).toContain('已点击')
      expect(result.content).toContain('applied')
    } finally { click.mockRestore() }
  })
})

describe('未知结果的执行约束', () => {
  test('Given 上次点击结果未知 When 再点同一坐标 Then 入口直接拒绝直到解除', async () => {
    const { resolveUnknownAction } = await import('../unknown-action-store')
    const ctx = { cwd: '/tmp', sessionId: 'cu-block-e2e' }
    const click = spyOn(computerUseService, 'click').mockRejectedValue(new Error('operation timed out'))
    try {
      const first = await executeComputerUseClickTool({ x: 3, y: 4 }, ctx)
      expect(first.isError).toBe(true)
      expect(first.content).toContain('结果未知')

      // 同一个动作再来一次：不应到达服务层，直接被拦截。
      click.mockClear()
      const second = await executeComputerUseClickTool({ x: 3, y: 4 }, ctx)
      expect(second.isError).toBe(true)
      expect(second.content).toContain('拒绝执行')
      expect(click).not.toHaveBeenCalled()

      // 不同坐标是另一次动作，不受影响。
      const other = await executeComputerUseClickTool({ x: 9, y: 9 }, ctx)
      expect(other.content).toContain('结果未知')
      expect(click).toHaveBeenCalledTimes(1)

      // 解除后才允许重试。
      await resolveUnknownAction({ sessionId: 'cu-block-e2e', actionKey: 'computer-use:click:3,4@primary', resolution: '用户截图确认未生效' })
      click.mockClear()
      click.mockResolvedValue('已点击 (3, 4)')
      const third = await executeComputerUseClickTool({ x: 3, y: 4 }, ctx)
      expect(third.isError).toBeFalsy()
      expect(click).toHaveBeenCalledTimes(1)
    } finally { click.mockRestore() }
  })
})
