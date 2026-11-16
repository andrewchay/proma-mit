import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-performance-'))
const handlers = new Map<string, (...args: never[]) => unknown>()
const sent: string[] = []
mock.module('electron', () => ({
  app: { getPath: () => directory, getVersion: () => 'test', getAppMetrics: () => [] },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  shell: { openPath: async () => '' },
  ipcMain: { handle: (name: string, handler: (...args: never[]) => unknown) => handlers.set(name, handler) },
}))
mock.module('../main-window', () => ({ getMainWindow: () => ({ webContents: { id: 1, send: (channel: string) => sent.push(channel) } }) }))
const { registerPerformanceMonitor } = await import('./performance-monitor')
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test('Given 主进程阻塞 When 收到主窗口请求 Then 保存有界且不含输入内容的记录', async () => {
  registerPerformanceMonitor()
  const until = performance.now() + 1250
  while (performance.now() < until) { /* 模拟主进程阻塞 */ }
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(sent).toContain('performance-monitor:main-stall')
  const handler = handlers.get('performance-monitor:auto')!
  const input = [{ timestamp: Date.now(), kind: 'input', durationMs: 40, streaming: true, text: '秘密输入' }]
  await handler({ sender: { id: 1 } } as never, input as never, 'main' as never)
  const files = readdirSync(join(directory, 'performance-diagnostics'))
  expect(files).toHaveLength(1)
  const content = readFileSync(join(directory, 'performance-diagnostics', files[0]!), 'utf8')
  expect(content).not.toContain('秘密输入')
  expect(JSON.parse(content).main.some((sample: { delayMs: number }) => sample.delayMs >= 200)).toBe(true)
  await expect(handler({ sender: { id: 2 } } as never, input as never, 'main' as never)).rejects.toThrow()
})
