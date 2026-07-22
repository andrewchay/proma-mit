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
  createWebBridgeNavigateToolDefinition,
  createWebBridgeSnapshotToolDefinition,
  createWebBridgeConnectChromeToolDefinition,
  createWebBridgeDownloadToolDefinition,
  createWebBridgeUploadToolDefinition,
  executeWebBridgeNavigateTool,
  executeWebBridgeTypeTool,
} = await import('./web-bridge-tools')
const { normalizeWebUrl } = await import('../../web-bridge-service')

describe('Web Bridge 工具', () => {
  test('仅接受不含凭据的 http/https URL', () => {
    expect(normalizeWebUrl('https://example.com/path')).toBe('https://example.com/path')
    expect(() => normalizeWebUrl('file:///etc/passwd')).toThrow('仅支持 http 或 https')
    expect(() => normalizeWebUrl('https://user:secret@example.com')).toThrow('不能包含用户名或密码')
  })

  test('工具定义包含导航与只读快照', () => {
    expect(createWebBridgeNavigateToolDefinition().name).toBe('WebBridgeNavigate')
    expect(createWebBridgeSnapshotToolDefinition().name).toBe('WebBridgeSnapshot')
    expect(createWebBridgeConnectChromeToolDefinition().name).toBe('WebBridgeConnectChrome')
    expect(createWebBridgeDownloadToolDefinition().name).toBe('WebBridgeDownload')
    expect(createWebBridgeUploadToolDefinition().name).toBe('WebBridgeUpload')
  })

  test('缺少必要参数时不访问浏览器', async () => {
    const ctx = { cwd: '/tmp', sessionId: 'web-bridge-test' }
    const navigate = await executeWebBridgeNavigateTool({}, ctx)
    const type = await executeWebBridgeTypeTool({ selector: '#query' }, ctx)

    expect(navigate.isError).toBe(true)
    expect(type.isError).toBe(true)
  })
})
