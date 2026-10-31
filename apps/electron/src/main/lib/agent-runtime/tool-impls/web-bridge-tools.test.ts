import { describe, expect, mock, test, beforeAll, afterAll, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../../testing/electron-mock'
import { bindTestToolContext } from '../../testing/bound-tool-context'


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
  executeWebBridgeStopTool,
  executeWebBridgeStatusTool,
  executeWebBridgeNavigateTool,
  executeWebBridgeTypeTool,
  executeWebBridgeClickTool,
  executeWebBridgeDownloadTool,
} = await import('./web-bridge-tools')
const { normalizeWebUrl, webBridgeService } = await import('../../web-bridge-service')
/** 工具入口要求已绑定会话身份：测试显式按 Runtime 的方式绑定。 */
const bridgeCtx = (sessionId: string, extra: Record<string, unknown> = {}) => bindTestToolContext({ cwd: '/tmp', sessionId, ...extra })
const directory = mkdtempSync(join(tmpdir(), 'bridge-tool-db-')), previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = directory; await (await import('../../project-sqlite-store')).initProjectDb() })
afterAll(async () => {
  (await import('../../project-sqlite-store')).closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

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

  test('Given 普通会话 When 查询浏览器状态 Then 进入浏览器服务', async () => {
    const status = spyOn(webBridgeService, 'getStatus')
    try {
      const result = await executeWebBridgeStatusTool({}, bindTestToolContext({ cwd: directory, sessionId: 'ordinary-bridge-session' }))
      expect(result.isError).toBeFalsy()
      expect(status).toHaveBeenCalledWith('ordinary-bridge-session')
    } finally { status.mockRestore() }
  })

  test('Given 受控标记与账本不一致 When 紧急停止 Then 仍允许关闭会话', async () => {
    const close = spyOn(webBridgeService, 'close').mockImplementation(() => {})
    try {
      const result = await executeWebBridgeStopTool({}, bindTestToolContext({ cwd: directory, sessionId: 'ordinary-bridge-session', ownerWorkspaceWrite: true }))
      expect(result.isError).toBeFalsy()
      expect(close).toHaveBeenCalledWith('ordinary-bridge-session')
    } finally { close.mockRestore() }
  })

  test('缺少必要参数时不访问浏览器', async () => {
    const ctx = bridgeCtx('web-bridge-test')
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

const fakeSnapshot = { url: 'https://example.com/', title: '示例', text: '正文', accessibility: [], accessibilityTree: [] }

describe('Web Bridge 动作结果分类', () => {
  // 每个用例独立 sessionId：结果未知会在执行入口拦截同指纹的重复动作。
  test('Given 连接在点击后关闭 When 执行 Then 结果未知且禁止自动重试', async () => {
    const ctx = bridgeCtx('bw-outcome-closed')
    const click = spyOn(webBridgeService, 'click').mockRejectedValue(new Error('Target closed'))
    try {
      const result = await executeWebBridgeClickTool({ element_id: 'r1-2' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('结果未知')
      expect(result.content).toContain('禁止自动重试')
      expect(result.content).toContain('WebBridgeObserve')
      const { listPendingUnknownActions } = await import('../unknown-action-store')
      expect((await listPendingUnknownActions(ctx.sessionId))[0]?.reason).toBe('Target closed')
    } finally { click.mockRestore() }
  })

  test('Given 服务报 ref 已失效 When 点击 Then 不能推断动作未生效', async () => {
    const ctx = bridgeCtx('bw-outcome-stale')
    const click = spyOn(webBridgeService, 'click').mockRejectedValue(new Error('No node with given id 42'))
    try {
      const result = await executeWebBridgeClickTool({ element_id: 'r1-9' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('结果未知')
      expect(result.content).toContain('禁止自动重试')
      expect(result.content).not.toContain('未执行')
    } finally { click.mockRestore() }
  })

  test('Given 输入时协议报错 When 执行 Then 保守判为未知', async () => {
    const ctx = bridgeCtx('bw-outcome-type')
    const type = spyOn(webBridgeService, 'type').mockRejectedValue(new Error('Protocol error (Input.insertText)'))
    try {
      const result = await executeWebBridgeTypeTool({ element_id: 'r1-3', text: 'hi' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('WebBridgeType 结果未知')
    } finally { type.mockRestore() }
  })

  test('Given 下载中断 When 执行 Then 指引核对落盘位置', async () => {
    const ctx = bridgeCtx('bw-outcome-download')
    const download = spyOn(webBridgeService, 'download').mockRejectedValue(new Error('socket hang up'))
    try {
      const result = await executeWebBridgeDownloadTool({ url: 'https://example.com/file.pdf' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('WebBridgeDownload 结果未知')
      expect(result.content).toContain('下载目录')
    } finally { download.mockRestore() }
  })

  test('Given 点击成功 When 执行 Then 返回快照且不出现未知提示', async () => {
    const ctx = bridgeCtx('bw-outcome-success')
    const click = spyOn(webBridgeService, 'click').mockResolvedValue(fakeSnapshot)
    try {
      const result = await executeWebBridgeClickTool({ element_id: 'r1-2' }, ctx)
      expect(result.isError).toBeFalsy()
      expect(result.content).toContain('https://example.com/')
      expect(result.content).not.toContain('结果未知')
    } finally { click.mockRestore() }
  })
})

describe('Web Bridge 失败动作审计', () => {
  const auditFile = join(directory, 'web-bridge-audit', 'events.jsonl')

  async function readEvents(): Promise<Array<{ action: string; detail: Record<string, unknown> }>> {
    try {
      const text = await readFile(auditFile, 'utf8')
      return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch { return [] }
  }

  // 审计是 fire-and-forget：同一文件里其他用例也会写 click 事件（错误文案可能相同），
  // 因此按本用例独有的 element_id 匹配，而不是取最后一条。
  async function waitForFailedClick(elementId: string): Promise<Record<string, unknown> | undefined> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const events = await readEvents()
      const hit = events.find((event) => event.action === 'click' && event.detail.elementId === elementId)
      if (hit) return { ...hit.detail }
      await Bun.sleep(20)
    }
    return undefined
  }

  test('Given 结果未知 When 点击失败 Then 审计记 outcome 且不写页面正文', async () => {
    const click = spyOn(webBridgeService, 'click').mockRejectedValue(new Error('Target closed'))
    try {
      await executeWebBridgeClickTool({ element_id: 'r1-5' }, bridgeCtx('bridge-audit-session'))
      const detail = await waitForFailedClick('r1-5')
      expect(detail?.outcome).toBe('unknown')
      expect(String(detail?.error)).toContain('Target closed')
      expect(detail?.text).toBeUndefined()
      expect(detail?.elementId).toBe('r1-5')
    } finally { click.mockRestore() }
  })
})

describe('Web Bridge 未知结果的执行约束', () => {
  test('Given 上次点击结果未知 When 点同一元素 Then 不触达浏览器服务', async () => {
    const ctx = bridgeCtx('bw-block-e2e')
    const click = spyOn(webBridgeService, 'click').mockRejectedValue(new Error('Target closed'))
    try {
      const first = await executeWebBridgeClickTool({ element_id: 'r2-1' }, ctx)
      expect(first.content).toContain('结果未知')
      click.mockClear()

      const second = await executeWebBridgeClickTool({ element_id: 'r2-1' }, ctx)
      expect(second.content).toContain('拒绝执行')
      expect(second.content).toContain('WebBridgeObserve')
      expect(click).not.toHaveBeenCalled()
    } finally { click.mockRestore() }
  })
})
