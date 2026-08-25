import { describe, expect, mock, test } from 'bun:test'
import { buildElectronMock } from '../../testing/electron-mock'


mock.module('electron', () => buildElectronMock())

const {
  createWebBridgeNavigateToolDefinition,
  createWebBridgeSnapshotToolDefinition,
  createWebBridgeScreenshotToolDefinition,
  createWebBridgeConnectChromeToolDefinition,
  createWebBridgeClickToolDefinition,
  createWebBridgeDownloadToolDefinition,
  createWebBridgeUploadToolDefinition,
  createWebBridgeScreenshotResult,
  createWebBridgeObserveToolDefinition,
  createWebBridgeNewTabToolDefinition,
  createWebBridgeListTabsToolDefinition,
  createWebBridgeSelectTabToolDefinition,
  createWebBridgeCloseTabToolDefinition,
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
    expect(createWebBridgeClickToolDefinition().parameters.properties.element_id).toBeDefined()
    expect(createWebBridgeSnapshotToolDefinition().description).toContain('必须先成功调用 WebBridgeNavigate')
    expect(createWebBridgeScreenshotToolDefinition().description).toContain('第一步必须是 WebBridgeNavigate')
  })

  test('缺少必要参数时不访问浏览器', async () => {
    const ctx = { cwd: '/tmp', sessionId: 'web-bridge-test' }
    const navigate = await executeWebBridgeNavigateTool({}, ctx)
    const type = await executeWebBridgeTypeTool({ selector: '#query' }, ctx)

    expect(navigate.isError).toBe(true)
    expect(type.isError).toBe(true)
  })

  test('given a screenshot when its result is built then it retains both image and readable page snapshot', () => {
    const result = createWebBridgeScreenshotResult(
      {
        url: 'https://ccunpacked.dev/#agent-loop',
        title: 'Agent Loop',
        text: 'Agent loop content',
        accessibility: [{ elementId: 'main-e-1', role: 'link', name: 'Next', selector: 'a[href="#next"]', disabled: false }],
        accessibilityTree: [{ elementId: 'main-e-1', role: 'link', name: 'Next', selector: 'a[href="#next"]', disabled: false }],
      },
      { mediaType: 'image/png', data: 'AQID' },
    )

    expect(result.content).toContain('结构化页面快照')
    expect(result.content).toContain('ccunpacked.dev')
    expect(result.imageData).toEqual([{ mediaType: 'image/png', data: 'AQID' }])
  })

  test('工具定义包含 AX 观察与多标签工具', () => {
    expect(createWebBridgeObserveToolDefinition().name).toBe('WebBridgeObserve')
    expect(createWebBridgeNewTabToolDefinition().name).toBe('WebBridgeNewTab')
    expect(createWebBridgeListTabsToolDefinition().name).toBe('WebBridgeListTabs')
    expect(createWebBridgeSelectTabToolDefinition().name).toBe('WebBridgeSelectTab')
    expect(createWebBridgeCloseTabToolDefinition().name).toBe('WebBridgeCloseTab')

    // SelectTab / CloseTab 需要 tab_id；Observe / NewTab 可选
    expect(createWebBridgeSelectTabToolDefinition().parameters.required).toEqual(['tab_id'])
    expect(createWebBridgeCloseTabToolDefinition().parameters.required).toEqual(['tab_id'])
    expect(createWebBridgeNewTabToolDefinition().parameters.properties.url).toBeDefined()
  })
})
