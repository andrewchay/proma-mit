/** Web Bridge 工具：受管浏览器的导航、读取和受限 DOM 操作。 */

import type { ToolResult } from '@proma/core'
import type { ToolContext } from '../types'
import { webBridgeService, type WebBridgeSnapshot } from '../../web-bridge-service'
import { appendWebBridgeAudit } from '../../web-bridge-audit-service'

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

function snapshotResult(snapshot: WebBridgeSnapshot): ToolResult {
  return { toolCallId: '', content: JSON.stringify(snapshot, null, 2) }
}

export function createWebBridgeNavigateToolDefinition() {
  return { name: WEB_BRIDGE_NAVIGATE_TOOL_NAME, description: '在可见且隔离的 Proma Web Bridge 浏览器中打开一个 http/https 网页。导航会请求用户授权。', parameters: { type: 'object' as const, properties: { url: { type: 'string', description: '要打开的完整 http 或 https URL' } }, required: ['url'] } }
}
export function createWebBridgeSnapshotToolDefinition() {
  return { name: WEB_BRIDGE_SNAPSHOT_TOOL_NAME, description: '读取当前 Web Bridge 页面的 URL、标题和可见文本，不改变页面状态。', parameters: { type: 'object' as const, properties: {} } }
}
export function createWebBridgeScreenshotToolDefinition() {
  return { name: WEB_BRIDGE_SCREENSHOT_TOOL_NAME, description: '获取当前 Web Bridge 页面截图，用于页面文本不足时理解界面，不改变页面状态。', parameters: { type: 'object' as const, properties: {} } }
}
export function createWebBridgeClickToolDefinition() {
  return { name: WEB_BRIDGE_CLICK_TOOL_NAME, description: '点击当前网页中匹配 CSS selector 的元素。提交、购买、删除、发布或授权等有后果的操作必须先向用户确认。', parameters: { type: 'object' as const, properties: { selector: { type: 'string', description: '目标元素的 CSS selector' } }, required: ['selector'] } }
}
export function createWebBridgeTypeToolDefinition() {
  return { name: WEB_BRIDGE_TYPE_TOOL_NAME, description: '向当前网页的输入框或 contenteditable 元素输入文本。敏感信息、登录凭据或表单提交前必须先向用户确认。', parameters: { type: 'object' as const, properties: { selector: { type: 'string', description: '输入元素的 CSS selector' }, text: { type: 'string', description: '要输入的文本' }, submit: { type: 'boolean', description: '是否在输入后按 Enter；默认 false' } }, required: ['selector', 'text'] } }
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
  return { name: WEB_BRIDGE_UPLOAD_TOOL_NAME, description: '向当前网页的文件上传控件上传文件。每次都会逐次请求用户授权，并弹出系统文件选择器；Agent 不能指定或读取本地路径。最多选择 10 个文件、总计 50MB。上传到网页后，提交、发布或支付等后续操作仍需单独确认。', parameters: { type: 'object' as const, properties: { selector: { type: 'string', description: '文件上传 input 元素的 CSS selector' } }, required: ['selector'] } }
}
export function createWebBridgeStatusToolDefinition() { return { name: WEB_BRIDGE_STATUS_TOOL_NAME, description: '读取当前 Web Bridge 的连接模式、页面地址和结构化页面可用状态，不改变页面状态。', parameters: { type: 'object' as const, properties: {} } } }
export function createWebBridgeStopToolDefinition() { return { name: WEB_BRIDGE_STOP_TOOL_NAME, description: '立即关闭当前会话的受管浏览器或 Chrome CDP 连接，不会关闭用户的 Chrome。', parameters: { type: 'object' as const, properties: {} } } }

export async function executeWebBridgeNavigateTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const url = readString(input, 'url')
  if (!url) return error('url 必须是非空字符串')
  const snapshot = await webBridgeService.navigate(ctx.sessionId, url)
  audit(ctx, 'navigate', { url: snapshot.url })
  return snapshotResult(snapshot)
}
export async function executeWebBridgeSnapshotTool(_input: unknown, ctx: ToolContext): Promise<ToolResult> { return snapshotResult(await webBridgeService.snapshot(ctx.sessionId)) }
export async function executeWebBridgeScreenshotTool(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const screenshot = await webBridgeService.screenshot(ctx.sessionId)
  return { toolCallId: '', content: 'Web Bridge 页面截图已附加。', imageData: [{ mediaType: screenshot.mediaType, data: screenshot.data }] }
}
export async function executeWebBridgeClickTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const selector = readString(input, 'selector')
  if (!selector) return error('selector 必须是非空字符串')
  const snapshot = await webBridgeService.click(ctx.sessionId, selector)
  audit(ctx, 'click', { selector })
  return snapshotResult(snapshot)
}
export async function executeWebBridgeTypeTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const selector = readString(input, 'selector'); const text = readString(input, 'text')
  if (!selector || text === undefined) return error('selector 和 text 必须是字符串')
  const submit = isRecord(input) && input.submit === true
  const snapshot = await webBridgeService.type(ctx.sessionId, selector, text, submit)
  audit(ctx, 'type', { selector, length: text.length, submit })
  return snapshotResult(snapshot)
}
export async function executeWebBridgeScrollTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const direction = isRecord(input) && input.direction === 'up' ? 'up' : isRecord(input) && input.direction === 'down' ? 'down' : undefined
  if (!direction) return error('direction 必须为 up 或 down')
  const amount = isRecord(input) && typeof input.amount === 'number' ? input.amount : 700
  const snapshot = await webBridgeService.scroll(ctx.sessionId, direction, amount)
  audit(ctx, 'scroll', { direction, amount })
  return snapshotResult(snapshot)
}
export async function executeWebBridgeChromeTargetsTool(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
  const port = readPort(input)
  return { toolCallId: '', content: JSON.stringify(await webBridgeService.listChromeTargets(port), null, 2) }
}
export async function executeWebBridgeConnectChromeTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const port = readPort(input)
  const targetId = readString(input, 'target_id')
  const snapshot = await webBridgeService.connectChrome(ctx.sessionId, port, targetId)
  audit(ctx, 'connect_chrome', { port, targetId })
  return snapshotResult(snapshot)
}
export async function executeWebBridgeDownloadTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const url = readString(input, 'url')
  if (!url) return error('url 必须是非空字符串')
  const download = await webBridgeService.download(ctx.sessionId, url)
  audit(ctx, 'download', { bytes: download.bytes, contentType: download.contentType })
  return { toolCallId: '', content: JSON.stringify(download, null, 2) }
}
export async function executeWebBridgeUploadTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const selector = readString(input, 'selector')
  if (!selector) return error('selector 必须是非空字符串')
  const upload = await webBridgeService.selectAndUpload(ctx.sessionId, selector)
  audit(ctx, 'upload', { selector, files: upload.files.map(({ name, bytes, contentType }) => ({ name, bytes, contentType })) })
  return { toolCallId: '', content: JSON.stringify(upload, null, 2) }
}
export async function executeWebBridgeStatusTool(_input: unknown, ctx: ToolContext): Promise<ToolResult> { return { toolCallId: '', content: JSON.stringify(webBridgeService.getStatus(ctx.sessionId), null, 2) } }
export async function executeWebBridgeStopTool(_input: unknown, ctx: ToolContext): Promise<ToolResult> { webBridgeService.close(ctx.sessionId); audit(ctx, 'stop', {}); return { toolCallId: '', content: JSON.stringify({ stopped: true }) } }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function readString(value: unknown, key: string): string | undefined { return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined }
function readPort(value: unknown): number { return isRecord(value) && typeof value.port === 'number' ? value.port : 9222 }
function error(content: string): ToolResult { return { toolCallId: '', content, isError: true } }
function audit(ctx: ToolContext, action: string, detail: Record<string, unknown>): void { void appendWebBridgeAudit(ctx.sessionId, action, detail).catch(() => undefined) }
