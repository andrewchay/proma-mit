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
  const ctx = { cwd: '/tmp', sessionId: 'computer-outcome-test' }

  test('Given 服务超时 When 点击 Then 标记结果未知并禁止自动重试', async () => {
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

  test('Given 权限被拒绝 When 点击 Then 标记未执行且允许修正后重试', async () => {
    const click = spyOn(computerUseService, 'click').mockRejectedValue(Object.assign(new Error('not permitted'), { code: 'EPERM' }))
    try {
      const result = await executeComputerUseClickTool({ x: 10, y: 20 }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('未执行')
      expect(result.content).not.toContain('结果未知')
    } finally { click.mockRestore() }
  })

  test('Given 未知异常 When 输入 Then 保守判为结果未知', async () => {
    const type = spyOn(computerUseService, 'type').mockRejectedValue(new Error('CGEventPost failed'))
    try {
      const result = await executeComputerUseTypeTool({ text: 'hello' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('结果未知')
    } finally { type.mockRestore() }
  })

  test('Given 成功 When 点击 Then 结果标记 applied 且保留原始 message', async () => {
    const click = spyOn(computerUseService, 'click').mockResolvedValue('已点击 (10, 20)')
    try {
      const result = await executeComputerUseClickTool({ x: 10, y: 20 }, ctx)
      expect(result.isError).toBeFalsy()
      expect(result.content).toContain('已点击')
      expect(result.content).toContain('applied')
    } finally { click.mockRestore() }
  })
})
