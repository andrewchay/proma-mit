import { describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class MockBrowserWindow {},
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  desktopCapturer: { getSources: async () => [] },
  screen: { getPrimaryDisplay: () => ({ size: { width: 1, height: 1 }, scaleFactor: 1 }) },
  session: { fromPartition: () => ({}) },
}))

const {
  createComputerUseStatusToolDefinition,
  createComputerUseClickToolDefinition,
  createComputerUseMoveToolDefinition,
  createComputerUseDoubleClickToolDefinition,
  createComputerUseDragToolDefinition,
  createComputerUseKeyComboToolDefinition,
  createComputerUseRequestTakeoverToolDefinition,
  executeComputerUseClickTool,
  executeComputerUseScrollTool,
  executeComputerUseRequestTakeoverTool,
} = await import('./computer-use-tools')

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
