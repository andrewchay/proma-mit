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
