import { describeDispatchedActionFailure } from './external-action-outcome'
/** Web Bridge 工具：受管浏览器的导航、读取和受限 DOM 操作。 */

import type { ToolResult } from '@gravitas/core'
import type { ToolContext } from '../types'
import { webBridgeService, type WebBridgeSnapshot } from '../../web-bridge-service'
import { appendWebBridgeAudit } from '../../web-bridge-audit-service'
import { guardOwnerTool } from './tool-utils'
import { DOWNLOAD_CONFIRM_HINT } from './web-bridge-outcome'
import { beginTrackedAction, finishTrackedAction, blockIfUnknownAction, buildActionKey, hashDetail } from '../unknown-action-store'

export const WEB_BRIDGE_NAVIGATE_TOOL_NAME = 'WebBridgeNavigate'
export const WEB_BRIDGE_SNAPSHOT_TOOL_NAME = 'WebBridgeSnapshot'
export const WEB_BRIDGE_SCREENSHOT_TOOL_NAME = 'WebBridgeScreenshot'
export const WEB_BRIDGE_CLICK_TOOL_NAME = 'WebBridgeClick'
export const WEB_BRIDGE_TYPE_TOOL_NAME = 'WebBridgeType'
export const WEB_BRIDGE_SCROLL_TOOL_NAME = 'WebBridgeScroll'
export const WEB_BRIDGE_CHROME_TARGETS_TOOL_NAME = 'WebBridgeChromeTargets'
export const WEB_BRIDGE_CONNECT_CHROME_TOOL_NAME = 'WebBridgeConnectChrome'
export const WEB_BRIDGE_DOWNLOAD_TOOL_NAME = 'WebBridgeDownload'
export const WEB_BRIDGE_UPLOAD_TOOL_NAME = 'WebBridgeUpload'
export const WEB_BRIDGE_STATUS_TOOL_NAME = 'WebBridgeStatus'
export const WEB_BRIDGE_STOP_TOOL_NAME = 'WebBridgeStop'
export const WEB_BRIDGE_OBSERVE_TOOL_NAME = 'WebBridgeObserve'
export const WEB_BRIDGE_NEW_TAB_TOOL_NAME = 'WebBridgeNewTab'
export const WEB_BRIDGE_LIST_TABS_TOOL_NAME = 'WebBridgeListTabs'
export const WEB_BRIDGE_SELECT_TAB_TOOL_NAME = 'WebBridgeSelectTab'
export const WEB_BRIDGE_CLOSE_TAB_TOOL_NAME = 'WebBridgeCloseTab'

function snapshotResult(snapshot: WebBridgeSnapshot): ToolResult {
  return { toolCallId: '', content: JSON.stringify(snapshot, null, 2) }
}

/**
 * 截图结果同时携带结构化快照。
 *
 * 部分 OpenAI 兼容 Provider 与 Pi 的 Provider 适配层不会稳定地消费工具结果中的
 * 图片内容。保留图片供支持视觉的模型使用，并提供同一页面的文本快照作为可靠降级，
 * 这样模型仍能在截图后继续理解并回答用户。
 */
export function createWebBridgeScreenshotResult(
  snapshot: WebBridgeSnapshot,
  screenshot: { mediaType: string; data: string },
): ToolResult {
  return {
    toolCallId: '',
    content: `Web Bridge 页面截图已附加。以下是与截图对应的结构化页面快照，请基于截图和快照理解页面内容：\n${JSON.stringify(snapshot, null, 2)}`,
    imageData: [{ mediaType: screenshot.mediaType, data: screenshot.data }],
  }
}

export function createWebBridgeNavigateToolDefinition() {
  return { name: WEB_BRIDGE_NAVIGATE_TOOL_NAME, description: '在可见且隔离的 Proma Web Bridge 浏览器中打开一个 http/https 网页。导航会请求用户授权。', parameters: { type: 'object' as const, properties: { url: { type: 'string', description: '要打开的完整 http 或 https URL' } }, required: ['url'] } }
}
export function createWebBridgeSnapshotToolDefinition() {
  return { name: WEB_BRIDGE_SNAPSHOT_TOOL_NAME, description: '读取当前 Web Bridge 页面的 URL、标题和可见文本，不改变页面状态。前置条件：必须先成功调用 WebBridgeNavigate 或 WebBridgeConnectChrome；对于“打开 URL 后查看页面”的任务，绝不能把本工具作为第一个网页工具。', parameters: { type: 'object' as const, properties: {} } }
}
export function createWebBridgeScreenshotToolDefinition() {
  return { name: WEB_BRIDGE_SCREENSHOT_TOOL_NAME, description: '获取当前 Web Bridge 页面截图，用于页面文本不足时理解界面，不改变页面状态。前置条件：必须先成功调用 WebBridgeNavigate 或 WebBridgeConnectChrome；当用户同时提供 URL 并要求截图时，第一步必须是 WebBridgeNavigate，不能先调用本工具。', parameters: { type: 'object' as const, properties: {} } }
}
export function createWebBridgeClickToolDefinition() {
  return { name: WEB_BRIDGE_CLICK_TOOL_NAME, description: '点击当前网页中由 WebBridgeObserve 返回的 AX ref 元素，走 CDP 真实输入。提交、购买、删除、发布或授权等有后果的操作必须先向用户确认。', parameters: { type: 'object' as const, properties: { element_id: { type: 'string', description: '来自最近 WebBridgeObserve 的 AX ref（形如 r{g}-{i}）。导航或重新观察后失效，需重新 Observe。' } }, required: ['element_id'] } }
}
export function createWebBridgeTypeToolDefinition() {
  return { name: WEB_BRIDGE_TYPE_TOOL_NAME, description: '向当前网页中由 WebBridgeObserve 返回的 AX ref 元素输入文本（CDP insertText 整段替换）。敏感信息、登录凭据或表单提交前必须先向用户确认。', parameters: { type: 'object' as const, properties: { element_id: { type: 'string', description: '来自最近 WebBridgeObserve 的 AX ref（形如 r{g}-{i}）。' }, text: { type: 'string', description: '要输入的文本' }, submit: { type: 'boolean', description: '是否在输入后按 Enter；默认 false' } }, required: ['element_id', 'text'] } }
}
export function createWebBridgeScrollToolDefinition() {
  return { name: WEB_BRIDGE_SCROLL_TOOL_NAME, description: '滚动当前 Web Bridge 页面，不改变外部状态。', parameters: { type: 'object' as const, properties: { direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向' }, amount: { type: 'number', description: '滚动像素，100 到 2000，默认 700' } }, required: ['direction'] } }
}
export function createWebBridgeChromeTargetsToolDefinition() {
  return { name: WEB_BRIDGE_CHROME_TARGETS_TOOL_NAME, description: '列出用户主动开启 Chrome 远程调试后可连接的页面；只读取本机 loopback 调试端口，不读取页面内容。', parameters: { type: 'object' as const, properties: { port: { type: 'number', description: 'Chrome --remote-debugging-port 指定的端口，默认 9222' } } } }
}
export function createWebBridgeConnectChromeToolDefinition() {
  return { name: WEB_BRIDGE_CONNECT_CHROME_TOOL_NAME, description: '连接用户主动开启远程调试的 Chrome 页面，复用该页面的登录态。连接和后续写操作都需要用户授权；不会启动或关闭 Chrome。', parameters: { type: 'object' as const, properties: { port: { type: 'number', description: 'Chrome --remote-debugging-port 指定的端口，默认 9222' }, target_id: { type: 'string', description: '可选，来自 WebBridgeChromeTargets 的页面 ID；默认第一个页面' } } } }
}
export function createWebBridgeDownloadToolDefinition() {
  return { name: WEB_BRIDGE_DOWNLOAD_TOOL_NAME, description: '下载 http/https 文件到当前会话的本地 Web Bridge 下载目录。下载会逐次请求用户授权，最大 50MB，不会自动打开文件。', parameters: { type: 'object' as const, properties: { url: { type: 'string', description: '要下载的完整 http 或 https URL' } }, required: ['url'] } }
}
export function createWebBridgeUploadToolDefinition() {
  return { name: WEB_BRIDGE_UPLOAD_TOOL_NAME, description: '向当前网页快照中指定 element_id 的文件上传控件上传文件。每次都会逐次请求用户授权，并弹出系统文件选择器；Agent 不能指定或读取本地路径。最多选择 10 个文件、总计 50MB。', parameters: { type: 'object' as const, properties: { element_id: { type: 'string', description: '来自最近 WebBridgeSnapshot 的稳定 elementId' }, selector: { type: 'string', description: '仅兼容旧会话；新调用必须使用 element_id' } }, required: [] } }
}
export function createWebBridgeStatusToolDefinition() { return { name: WEB_BRIDGE_STATUS_TOOL_NAME, description: '读取当前 Web Bridge 的连接模式、页面地址和结构化页面可用状态，不改变页面状态。', parameters: { type: 'object' as const, properties: {} } } }
export function createWebBridgeStopToolDefinition() { return { name: WEB_BRIDGE_STOP_TOOL_NAME, description: '立即关闭当前会话的受管浏览器或 Chrome CDP 连接，不会关闭用户的 Chrome。', parameters: { type: 'object' as const, properties: {} } } }
export function createWebBridgeObserveToolDefinition() {
  return { name: WEB_BRIDGE_OBSERVE_TOOL_NAME, description: '读取当前 Web Bridge 工作标签的结构化无障碍（AX）元素列表（ref/role/name/editable），可交互元素优先。ref 会在导航或重新观察后失效，操作前需重新 Observe。', parameters: { type: 'object' as const, properties: {} } }
}
export function createWebBridgeNewTabToolDefinition() {
  return { name: WEB_BRIDGE_NEW_TAB_TOOL_NAME, description: '创建一个新的 Agent 工作标签并激活为可见（用户能看到接下来的操作）。可选导航到指定 URL。', parameters: { type: 'object' as const, properties: { url: { type: 'string', description: '可选：新标签要打开的 URL' } } } }
}
export function createWebBridgeListTabsToolDefinition() {
  return { name: WEB_BRIDGE_LIST_TABS_TOOL_NAME, description: '列出当前 Web Bridge 会话的所有标签及其 URL、标题。用于多标签并行操作时确认 tabId。', parameters: { type: 'object' as const, properties: {} } }
}
export function createWebBridgeSelectTabToolDefinition() {
  return { name: WEB_BRIDGE_SELECT_TAB_TOOL_NAME, description: '把指定 tabId 设为当前工作标签并激活为可见。tabId 来自 WebBridgeListTabs 或 WebBridgeNewTab。', parameters: { type: 'object' as const, properties: { tab_id: { type: 'string', description: '要切换到的标签 ID' } }, required: ['tab_id'] } }
}
export function createWebBridgeCloseTabToolDefinition() {
  return { name: WEB_BRIDGE_CLOSE_TAB_TOOL_NAME, description: '关闭指定 tabId 的标签。tabId 来自 WebBridgeListTabs。', parameters: { type: 'object' as const, properties: { tab_id: { type: 'string', description: '要关闭的标签 ID' } }, required: ['tab_id'] } }
}

async function executeWebBridgeNavigateUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const url = readString(input, 'url')
  if (!url) return error('url 必须是非空字符串')
  return runWebBridgeAction({
    action: 'navigate', display: 'Navigate', ctx, detail: { url },
    run: async () => {
      const snapshot = await webBridgeService.navigate(ctx.sessionId, url)
      return { result: snapshotResult(snapshot), detail: { url: snapshot.url } }
    },
  })
}
async function executeWebBridgeSnapshotUnchecked(_input: unknown, ctx: ToolContext): Promise<ToolResult> { return snapshotResult(await webBridgeService.snapshot(ctx.sessionId)) }
async function executeWebBridgeScreenshotUnchecked(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const screenshot = await webBridgeService.screenshot(ctx.sessionId)
  const snapshot = await webBridgeService.snapshot(ctx.sessionId)
  return createWebBridgeScreenshotResult(snapshot, screenshot)
}
async function executeWebBridgeClickUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const target = readTarget(input)
  if (!target) return error('element_id 必须来自最近 WebBridgeSnapshot')
  return runWebBridgeAction({
    action: 'click', display: 'Click', ctx, detail: target,
    run: async () => ({ result: snapshotResult(await webBridgeService.click(ctx.sessionId, target)) }),
  })
}
async function executeWebBridgeTypeUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const target = readTarget(input); const text = readString(input, 'text')
  if (!target || text === undefined) return error('element_id 和 text 必须是字符串')
  const submit = isRecord(input) && input.submit === true
  return runWebBridgeAction({
    action: 'type', display: 'Type', ctx, detail: { ...target, length: text.length, submit },
    run: async () => ({ result: snapshotResult(await webBridgeService.type(ctx.sessionId, target, text, submit)) }),
  })
}
async function executeWebBridgeScrollUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const direction = isRecord(input) && input.direction === 'up' ? 'up' : isRecord(input) && input.direction === 'down' ? 'down' : undefined
  if (!direction) return error('direction 必须为 up 或 down')
  const amount = isRecord(input) && typeof input.amount === 'number' ? input.amount : 700
  return runWebBridgeAction({
    action: 'scroll', display: 'Scroll', ctx, detail: { direction, amount },
    run: async () => ({ result: snapshotResult(await webBridgeService.scroll(ctx.sessionId, direction, amount)) }),
  })
}
async function executeWebBridgeChromeTargetsUnchecked(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
  const port = readPort(input)
  return { toolCallId: '', content: JSON.stringify(await webBridgeService.listChromeTargets(port), null, 2) }
}
async function executeWebBridgeConnectChromeUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const port = readPort(input)
  const targetId = readString(input, 'target_id')
  return runWebBridgeAction({
    action: 'connect_chrome', display: 'ConnectChrome', ctx, detail: { port, targetId },
    run: async () => ({ result: snapshotResult(await webBridgeService.connectChrome(ctx.sessionId, port, targetId)) }),
  })
}
async function executeWebBridgeDownloadUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const url = readString(input, 'url')
  if (!url) return error('url 必须是非空字符串')
  return runWebBridgeAction({
    action: 'download', display: 'Download', ctx, detail: { url }, hint: DOWNLOAD_CONFIRM_HINT,
    run: async () => {
      const download = await webBridgeService.download(ctx.sessionId, url)
      return {
        result: { toolCallId: '', content: JSON.stringify(download, null, 2) },
        detail: { bytes: download.bytes, contentType: download.contentType },
      }
    },
  })
}
async function executeWebBridgeUploadUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const target = readTarget(input)
  if (!target) return error('element_id 必须来自最近 WebBridgeSnapshot')
  return runWebBridgeAction({
    action: 'upload', display: 'Upload', ctx, detail: target,
    run: async () => {
      const upload = await webBridgeService.selectAndUpload(ctx.sessionId, target)
      return {
        result: { toolCallId: '', content: JSON.stringify(upload, null, 2) },
        detail: { files: upload.files.map(({ name, bytes, contentType }) => ({ name, bytes, contentType })) },
      }
    },
  })
}
async function executeWebBridgeStatusUnchecked(_input: unknown, ctx: ToolContext): Promise<ToolResult> { return { toolCallId: '', content: JSON.stringify(webBridgeService.getStatus(ctx.sessionId), null, 2) } }
export async function executeWebBridgeStopTool(_input: unknown, ctx: ToolContext): Promise<ToolResult> { webBridgeService.close(ctx.sessionId); audit(ctx, 'stop', {}); return { toolCallId: '', content: JSON.stringify({ stopped: true }) } }
async function executeWebBridgeObserveUnchecked(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const observation = await webBridgeService.observe(ctx.sessionId)
  audit(ctx, 'observe', { url: observation.url, tabId: observation.tabId })
  return { toolCallId: '', content: JSON.stringify(observation, null, 2) }
}
async function executeWebBridgeNewTabUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const url = readString(input, 'url')
  const tab = webBridgeService.createNewTab(ctx.sessionId, url)
  audit(ctx, 'new_tab', { tabId: tab.tabId, url: tab.url })
  return { toolCallId: '', content: JSON.stringify(tab, null, 2) }
}
async function executeWebBridgeListTabsUnchecked(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tabs = webBridgeService.listTabs(ctx.sessionId)
  audit(ctx, 'list_tabs', { count: tabs.length })
  return { toolCallId: '', content: JSON.stringify({ tabs }, null, 2) }
}
async function executeWebBridgeSelectTabUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tabId = readString(input, 'tab_id')
  if (!tabId) return error('tab_id 必须是非空字符串')
  const tab = await webBridgeService.selectTab(ctx.sessionId, tabId)
  audit(ctx, 'select_tab', { tabId })
  return { toolCallId: '', content: JSON.stringify(tab, null, 2) }
}
async function executeWebBridgeCloseTabUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tabId = readString(input, 'tab_id')
  if (!tabId) return error('tab_id 必须是非空字符串')
  await webBridgeService.closeTab(ctx.sessionId, tabId)
  audit(ctx, 'close_tab', { tabId })
  return { toolCallId: '', content: JSON.stringify({ closed: true, tabId }, null, 2) }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function readString(value: unknown, key: string): string | undefined { return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined }
function readTarget(value: unknown): { elementId?: string; selector?: string } | undefined { const elementId = readString(value, 'element_id'); const selector = readString(value, 'selector'); return elementId ? { elementId } : selector ? { selector } : undefined }
function readPort(value: unknown): number { return isRecord(value) && typeof value.port === 'number' ? value.port : 9222 }
function error(content: string): ToolResult { return { toolCallId: '', content, isError: true } }
function audit(ctx: ToolContext, action: string, detail: Record<string, unknown>): void { void appendWebBridgeAudit(ctx.sessionId, action, detail).catch(() => undefined) }

/**
 * 执行会改变外部状态的 Web Bridge 动作。
 *
 * 这类动作没有可核验回执：点击可能已经提交表单、输入可能已经写入、下载可能已经落盘。
 * 抛错时不再直接把异常抛给模型，而是先判定"未执行 / 结果未知"并写审计——
 * 结果未知一律禁止自动重试，要求先重新观察页面确认状态。
 */
async function runWebBridgeAction(params: {
  action: string
  display: string
  ctx: ToolContext
  detail: Record<string, unknown>
  run: () => Promise<{ result: ToolResult; detail?: Record<string, unknown> }>
  hint?: string
}): Promise<ToolResult> {
  const { action, display, ctx, detail, run, hint } = params
  // 未知结果必须拦住同一动作的重复调用，而不是只提示模型"别重试"。
  const actionKey = buildActionKey(
    `web-bridge:${action}`,
    String(detail.elementId ?? detail.url ?? hashDetail(detail)),
  )
  const blocked = await blockIfUnknownAction({
    sessionId: ctx.sessionId,
    tool: `WebBridge${display}`,
    actionKey,
    confirmHint: '请先重新 WebBridgeObserve 或 WebBridgeSnapshot 确认页面状态，并由用户决定是否继续。',
  })
  if (blocked) return error(blocked)
  const tracked = await beginTrackedAction({ sessionId: ctx.sessionId, tool: `WebBridge${display}`, actionKey, detail, reason: '动作已登记，结果待确认' })
  if (!tracked) return error('同一动作正在执行或等待核对，禁止重复派发')

  try {
    const { result, detail: extra } = await run()
    await finishTrackedAction(tracked, true)
    audit(ctx, action, { ...detail, ...extra, outcome: 'applied' })
    return result
  } catch (thrown) {
    const failure = describeDispatchedActionFailure(`WebBridge${display}`, thrown, hint ?? '请先调用 WebBridgeObserve 或 WebBridgeSnapshot 观察页面并由用户核对实际状态。')
    audit(ctx, action, { ...detail, outcome: failure.outcome, error: failure.reason })
    await finishTrackedAction(tracked, false, failure.reason)
    return error(failure.message)
  }
}

export const executeWebBridgeNavigateTool = guardOwnerTool(WEB_BRIDGE_NAVIGATE_TOOL_NAME, executeWebBridgeNavigateUnchecked)

export const executeWebBridgeSnapshotTool = guardOwnerTool(WEB_BRIDGE_SNAPSHOT_TOOL_NAME, executeWebBridgeSnapshotUnchecked)

export const executeWebBridgeScreenshotTool = guardOwnerTool(WEB_BRIDGE_SCREENSHOT_TOOL_NAME, executeWebBridgeScreenshotUnchecked)

export const executeWebBridgeClickTool = guardOwnerTool(WEB_BRIDGE_CLICK_TOOL_NAME, executeWebBridgeClickUnchecked)

export const executeWebBridgeTypeTool = guardOwnerTool(WEB_BRIDGE_TYPE_TOOL_NAME, executeWebBridgeTypeUnchecked)

export const executeWebBridgeScrollTool = guardOwnerTool(WEB_BRIDGE_SCROLL_TOOL_NAME, executeWebBridgeScrollUnchecked)

export const executeWebBridgeChromeTargetsTool = guardOwnerTool(WEB_BRIDGE_CHROME_TARGETS_TOOL_NAME, executeWebBridgeChromeTargetsUnchecked)

export const executeWebBridgeConnectChromeTool = guardOwnerTool(WEB_BRIDGE_CONNECT_CHROME_TOOL_NAME, executeWebBridgeConnectChromeUnchecked)

export const executeWebBridgeDownloadTool = guardOwnerTool(WEB_BRIDGE_DOWNLOAD_TOOL_NAME, executeWebBridgeDownloadUnchecked)

export const executeWebBridgeUploadTool = guardOwnerTool(WEB_BRIDGE_UPLOAD_TOOL_NAME, executeWebBridgeUploadUnchecked)

export const executeWebBridgeStatusTool = guardOwnerTool(WEB_BRIDGE_STATUS_TOOL_NAME, executeWebBridgeStatusUnchecked)

export const executeWebBridgeObserveTool = guardOwnerTool(WEB_BRIDGE_OBSERVE_TOOL_NAME, executeWebBridgeObserveUnchecked)

export const executeWebBridgeNewTabTool = guardOwnerTool(WEB_BRIDGE_NEW_TAB_TOOL_NAME, executeWebBridgeNewTabUnchecked)

export const executeWebBridgeListTabsTool = guardOwnerTool(WEB_BRIDGE_LIST_TABS_TOOL_NAME, executeWebBridgeListTabsUnchecked)

export const executeWebBridgeSelectTabTool = guardOwnerTool(WEB_BRIDGE_SELECT_TAB_TOOL_NAME, executeWebBridgeSelectTabUnchecked)

export const executeWebBridgeCloseTabTool = guardOwnerTool(WEB_BRIDGE_CLOSE_TAB_TOOL_NAME, executeWebBridgeCloseTabUnchecked)
