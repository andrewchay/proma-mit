/**
 * Web Bridge P0
 *
 * 每个 Agent 会话使用独立、可见的 Electron BrowserWindow。页面和登录态与 Proma
 * 主窗口隔离；Agent 只能通过有限的 DOM 操作访问页面，不能执行任意页面脚本。
 */

import * as electron from 'electron'
import type { BrowserWindow } from 'electron'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import WebSocket from 'ws'
import { getConfigDir } from './config-paths'

const WEB_BRIDGE_PARTITION_PREFIX = 'persist:proma-web-bridge-'
const MAX_SNAPSHOT_LENGTH = 16_000
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_UPLOAD_FILES = 10

export interface WebBridgeSnapshot {
  url: string
  title: string
  text: string
  accessibility: WebBridgeAccessibilityNode[]
  accessibilityTree: WebBridgeAccessibilityNode[]
}

export interface WebBridgeAccessibilityNode {
  role: string
  name: string
  selector: string
  disabled: boolean
}

export interface WebBridgeScreenshot {
  data: string
  mediaType: 'image/png'
}

export interface WebBridgeDownload {
  filePath: string
  bytes: number
  contentType: string
}

/** 上传结果不包含原始绝对路径，避免将用户本地目录暴露给 Agent。 */
export interface WebBridgeUpload {
  files: Array<{ name: string; bytes: number; contentType: string }>
}

interface SelectedUploadFile {
  name: string
  bytes: number
  contentType: string
  data: string
  lastModified: number
}

interface WebBridgeSession {
  window?: BrowserWindow
  cdp?: ChromeCdpClient
  targetId?: string
  lastSnapshot?: WebBridgeSnapshot
}

interface ChromeTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

class WebBridgeService {
  private sessions = new Map<string, WebBridgeSession>()

  async navigate(sessionId: string, rawUrl: string): Promise<WebBridgeSnapshot> {
    const url = normalizeWebUrl(rawUrl)
    const connected = this.sessions.get(sessionId)?.cdp
    if (connected) {
      await connected.call('Page.navigate', { url })
      await connected.waitForLoad()
      return this.snapshot(sessionId)
    }
    const window = this.getOrCreateWindow(sessionId)
    await window.loadURL(url)
    return this.snapshot(sessionId)
  }

  async snapshot(sessionId: string): Promise<WebBridgeSnapshot> {
    const connected = this.sessions.get(sessionId)?.cdp
    if (connected) {
      const result = await connected.evaluate(SNAPSHOT_SCRIPT)
      return this.rememberSnapshot(sessionId, snapshotFromRaw(await connected.evaluate('location.href'), result))
    }
    const window = this.requireWindow(sessionId)
    const result = await window.webContents.executeJavaScript(SNAPSHOT_SCRIPT, true)
    return this.rememberSnapshot(sessionId, snapshotFromRaw(window.webContents.getURL(), result))
  }

  async screenshot(sessionId: string): Promise<WebBridgeScreenshot> {
    const connected = this.sessions.get(sessionId)?.cdp
    if (connected) {
      const result = await connected.call('Page.captureScreenshot', { format: 'png' }) as { data?: unknown }
      if (typeof result.data !== 'string') throw new Error('Chrome 未返回截图')
      return { data: result.data, mediaType: 'image/png' }
    }
    const window = this.requireWindow(sessionId)
    const image = await window.webContents.capturePage()
    return { data: image.toPNG().toString('base64'), mediaType: 'image/png' }
  }

  async download(sessionId: string, rawUrl: string): Promise<WebBridgeDownload> {
    this.requireActiveSession(sessionId)
    const url = normalizeWebUrl(rawUrl)
    const response = await fetch(url, { redirect: 'error' })
    if (!response.ok || !response.body) throw new Error(`下载失败：${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('下载文件超过 50MB 限制')
    const fileName = safeDownloadFileName(response.headers.get('content-disposition'), url)
    const directory = join(getConfigDir(), 'web-bridge-downloads', sessionId)
    await mkdir(directory, { recursive: true })
    const filePath = join(directory, fileName)
    await writeFile(filePath, bytes)
    return { filePath, bytes: bytes.length, contentType: response.headers.get('content-type') ?? 'application/octet-stream' }
  }

  /**
   * 仅通过系统文件选择器取得文件，禁止 Agent 传入本地路径。文件内容只注入当前
   * Web Bridge 页面，不落盘、不暴露绝对路径；页面提交仍由网站自身流程控制。
   */
  async selectAndUpload(sessionId: string, selector: string): Promise<WebBridgeUpload> {
    this.requireActiveSession(sessionId)
    const owner = this.sessions.get(sessionId)?.window ?? electron.BrowserWindow.getFocusedWindow()
    const result = owner
      ? await electron.dialog.showOpenDialog(owner, { title: '选择要上传到当前网页的文件', properties: ['openFile', 'multiSelections'] })
      : await electron.dialog.showOpenDialog({ title: '选择要上传到当前网页的文件', properties: ['openFile', 'multiSelections'] })
    if (result.canceled || result.filePaths.length === 0) throw new Error('用户取消了文件上传')
    if (result.filePaths.length > MAX_UPLOAD_FILES) throw new Error(`单次最多上传 ${MAX_UPLOAD_FILES} 个文件`)

    const files = await this.readSelectedUploadFiles(result.filePaths)
    await this.setFileInput(sessionId, selector, files)
    return { files: files.map(({ name, bytes, contentType }) => ({ name, bytes, contentType })) }
  }

  async click(sessionId: string, selector: string): Promise<WebBridgeSnapshot> {
    const connected = this.sessions.get(sessionId)?.cdp
    if (connected) {
      await connected.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement)) throw new Error('未找到页面元素: ' + ${JSON.stringify(selector)});
        element.click();
      })()`)
      return this.snapshot(sessionId)
    }
    await this.runElementAction(sessionId, selector, 'click')
    return this.snapshot(sessionId)
  }

  async type(sessionId: string, selector: string, text: string, submit: boolean): Promise<WebBridgeSnapshot> {
    const connected = this.sessions.get(sessionId)?.cdp
    if (connected) {
      await connected.evaluate(buildTypeScript(selector, text, submit))
      return this.snapshot(sessionId)
    }
    const window = this.requireWindow(sessionId)
    await window.webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLElement && element.isContentEditable)) {
        throw new Error('未找到可输入的页面元素: ' + ${JSON.stringify(selector)});
      }
      element.focus();
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
        setter?.call(element, ${JSON.stringify(text)});
      } else {
        element.textContent = ${JSON.stringify(text)};
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      ${submit ? "element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));" : ''}
    })()`, true)
    return this.snapshot(sessionId)
  }

  async scroll(sessionId: string, direction: 'up' | 'down', amount: number): Promise<WebBridgeSnapshot> {
    const distance = Math.min(Math.max(amount, 100), 2_000) * (direction === 'down' ? 1 : -1)
    const connected = this.sessions.get(sessionId)?.cdp
    if (connected) {
      await connected.evaluate(`window.scrollBy({ top: ${distance}, behavior: 'instant' })`)
      return this.snapshot(sessionId)
    }
    const window = this.requireWindow(sessionId)
    await window.webContents.executeJavaScript(`window.scrollBy({ top: ${distance}, behavior: 'instant' })`, true)
    return this.snapshot(sessionId)
  }

  close(sessionId: string): void {
    const current = this.sessions.get(sessionId)
    if (!current) return
    this.sessions.delete(sessionId)
    current.cdp?.close()
    if (current.window && !current.window.isDestroyed()) current.window.close()
  }

  /** 关闭全部受管浏览器会话，供设置页紧急停止使用。 */
  closeAll(): number {
    const sessionIds = [...this.sessions.keys()]
    for (const sessionId of sessionIds) this.close(sessionId)
    return sessionIds.length
  }

  getStatus(sessionId: string): { active: boolean; mode?: 'managed' | 'chrome-cdp'; url?: string; accessibilityAvailable: boolean } {
    const current = this.sessions.get(sessionId)
    if (!current) return { active: false, accessibilityAvailable: false }
    return {
      active: true,
      mode: current.cdp ? 'chrome-cdp' : 'managed',
      url: current.lastSnapshot?.url,
      accessibilityAvailable: (current.lastSnapshot?.accessibility.length ?? 0) > 0,
    }
  }

  canUseComputerFallback(sessionId: string): boolean {
    const status = this.getStatus(sessionId)
    return !status.active || !status.accessibilityAvailable
  }

  /** 连接用户主动开启远程调试的 Chrome 页面，不启动、不关闭 Chrome。 */
  async connectChrome(sessionId: string, port: number, targetId?: string): Promise<WebBridgeSnapshot> {
    const targets = await listChromeTargets(port)
    const target = targetId ? targets.find((item) => item.id === targetId) : targets[0]
    if (!target?.webSocketDebuggerUrl) throw new Error('未找到可连接的 Chrome 页面')

    this.close(sessionId)
    const cdp = await ChromeCdpClient.connect(target.webSocketDebuggerUrl)
    await cdp.call('Page.enable')
    await cdp.call('Runtime.enable')
    this.sessions.set(sessionId, { cdp, targetId: target.id })
    return this.snapshot(sessionId)
  }

  async listChromeTargets(port: number): Promise<Array<Pick<ChromeTarget, 'id' | 'title' | 'url'>>> {
    const targets = await listChromeTargets(port)
    return targets.map(({ id, title, url }) => ({ id, title, url }))
  }

  private getOrCreateWindow(sessionId: string): BrowserWindow {
    const current = this.sessions.get(sessionId)
    if (current?.window && !current.window.isDestroyed()) {
      current.window.show()
      current.window.focus()
      return current.window
    }

    const browserSession = electron.session.fromPartition(`${WEB_BRIDGE_PARTITION_PREFIX}${sessionId}`, { cache: true })
    const window = new electron.BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 720,
      minHeight: 480,
      title: 'Proma Web Bridge',
      show: true,
      webPreferences: {
        session: browserSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    window.setMenuBarVisibility(false)
    // 不让网页自行创建未受管的新窗口；需要访问新页面时由 Agent 显式导航。
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => {
      if (!isSafeWebUrl(url)) event.preventDefault()
    })
    window.webContents.on('will-redirect', (event, url) => {
      if (!isSafeWebUrl(url)) event.preventDefault()
    })
    window.on('closed', () => this.sessions.delete(sessionId))
    this.sessions.set(sessionId, { window })
    return window
  }

  private requireWindow(sessionId: string): BrowserWindow {
    const current = this.sessions.get(sessionId)
    if (!current?.window || current.window.isDestroyed()) {
      throw new Error('当前会话尚未打开 Web Bridge；请先使用 WebBridgeNavigate 访问网页')
    }
    return current.window
  }

  private requireActiveSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) throw new Error('当前会话尚未打开 Web Bridge；请先使用 WebBridgeNavigate 或 WebBridgeConnectChrome')
  }

  private rememberSnapshot(sessionId: string, snapshot: WebBridgeSnapshot): WebBridgeSnapshot {
    const current = this.sessions.get(sessionId)
    if (current) current.lastSnapshot = snapshot
    return snapshot
  }

  private async runElementAction(sessionId: string, selector: string, action: 'click'): Promise<void> {
    const window = this.requireWindow(sessionId)
    await window.webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error('未找到页面元素: ' + ${JSON.stringify(selector)});
      element.${action}();
    })()`, true)
  }

  private async readSelectedUploadFiles(filePaths: string[]): Promise<SelectedUploadFile[]> {
    const files = await Promise.all(filePaths.map(async (filePath) => {
      const info = await stat(filePath)
      if (!info.isFile()) throw new Error('只能上传普通文件')
      const data = await readFile(filePath)
      return {
        name: filePath.split('/').pop() || 'upload',
        bytes: data.length,
        contentType: contentTypeForFileName(filePath),
        data: data.toString('base64'),
        lastModified: info.mtimeMs,
      }
    }))
    const totalBytes = files.reduce((total, file) => total + file.bytes, 0)
    if (totalBytes > MAX_UPLOAD_BYTES) throw new Error('上传文件总大小超过 50MB 限制')
    return files
  }

  private async setFileInput(sessionId: string, selector: string, files: SelectedUploadFile[]): Promise<void> {
    const script = buildUploadScript(selector, files)
    const connected = this.sessions.get(sessionId)?.cdp
    if (connected) {
      await connected.evaluate(script)
      return
    }
    const window = this.requireWindow(sessionId)
    await window.webContents.executeJavaScript(script, true)
  }
}

/** 最小 CDP client：只支持本服务需要的 request/response 和加载等待。 */
class ChromeCdpClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>()
  private loadResolvers: Array<() => void> = []

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: string | Buffer | ArrayBuffer | Uint8Array) => {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
      this.handleMessage(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf-8'))
    })
    socket.on('close', () => this.rejectPending(new Error('Chrome CDP 连接已关闭')))
    socket.on('error', (error: Error) => this.rejectPending(error))
  }

  static async connect(endpoint: string): Promise<ChromeCdpClient> {
    const socket = new WebSocket(endpoint)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return new ChromeCdpClient(socket)
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.socket.send(JSON.stringify({ id, method, ...(params && { params }) }))
    return result
  }

  async evaluate(expression: string): Promise<unknown> {
    const response = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const result = isRecord(response) && isRecord(response.result) ? response.result : undefined
    if (isRecord(result) && result.exceptionDetails) throw new Error('Chrome 页面脚本执行失败')
    return isRecord(result) ? result.value : undefined
  }

  async waitForLoad(): Promise<void> {
    await Promise.race([
      new Promise<void>((resolve) => this.loadResolvers.push(resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ])
  }

  close(): void { this.socket.close() }

  private handleMessage(raw: string): void {
    let payload: unknown
    try { payload = JSON.parse(raw) } catch { return }
    if (!isRecord(payload)) return
    if (payload.method === 'Page.loadEventFired') {
      const resolvers = this.loadResolvers.splice(0)
      resolvers.forEach((resolve) => resolve())
    }
    if (typeof payload.id !== 'number') return
    const pending = this.pending.get(payload.id)
    if (!pending) return
    this.pending.delete(payload.id)
    if (payload.error && isRecord(payload.error)) {
      pending.reject(new Error(typeof payload.error.message === 'string' ? payload.error.message : 'Chrome CDP 请求失败'))
      return
    }
    pending.resolve(payload.result)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

async function listChromeTargets(port: number): Promise<ChromeTarget[]> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Chrome 调试端口必须在 1024 到 65535 之间')
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) throw new Error(`无法连接 Chrome 调试端口 ${port}`)
  const data = await response.json()
  if (!Array.isArray(data)) throw new Error('Chrome 返回了无效的页面列表')
  return data.filter((item): item is ChromeTarget => isRecord(item) && item.type === 'page' && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.url === 'string')
}

function buildTypeScript(selector: string, text: string, submit: boolean): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLElement && element.isContentEditable)) throw new Error('未找到可输入的页面元素: ' + ${JSON.stringify(selector)});
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set?.call(element, ${JSON.stringify(text)});
    else element.textContent = ${JSON.stringify(text)};
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    ${submit ? "element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));" : ''}
  })()`
}

function buildUploadScript(selector: string, files: SelectedUploadFile[]): string {
  return `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') throw new Error('未找到文件上传控件: ' + ${JSON.stringify(selector)});
    const uploads = ${JSON.stringify(files)};
    if (!input.multiple && uploads.length > 1) throw new Error('目标上传控件仅支持单个文件');
    const transfer = new DataTransfer();
    for (const upload of uploads) {
      const bytes = Uint8Array.from(atob(upload.data), (character) => character.charCodeAt(0));
      transfer.items.add(new File([bytes], upload.name, { type: upload.contentType, lastModified: upload.lastModified }));
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`
}

const SNAPSHOT_SCRIPT = `(() => {
  const selectorFor = (element) => {
    if (element.id) return '#' + CSS.escape(element.id);
    const name = element.getAttribute('name');
    if (name) return element.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
    const role = element.getAttribute('role');
    if (role) return '[role="' + CSS.escape(role) + '"]';
    return element.tagName.toLowerCase();
  };
  const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]')]
    .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
    .slice(0, 200)
    .map((element) => ({
      role: element.getAttribute('role') || element.tagName.toLowerCase(),
      name: (element.getAttribute('aria-label') || element.innerText || element.getAttribute('placeholder') || element.getAttribute('title') || '').trim().slice(0, 200),
      selector: selectorFor(element),
      disabled: 'disabled' in element && Boolean(element.disabled),
    }));
  const tree = [];
  const walk = (element, depth) => {
    if (!(element instanceof HTMLElement) || element.offsetParent === null || tree.length >= 500 || depth > 6) return;
    const name = (element.getAttribute('aria-label') || element.innerText || element.getAttribute('placeholder') || '').trim().slice(0, 200);
    const role = element.getAttribute('role') || element.tagName.toLowerCase();
    if (name || ['main', 'nav', 'form', 'dialog', 'button', 'input'].includes(role)) tree.push({ role, name, selector: selectorFor(element), disabled: 'disabled' in element && Boolean(element.disabled) });
    [...element.children].forEach((child) => walk(child, depth + 1));
  };
  walk(document.body, 0);
  return { title: document.title, text: (document.body?.innerText || '').slice(0, 16000), accessibility: elements, accessibilityTree: tree };
})()`

function snapshotFromRaw(url: unknown, raw: unknown): WebBridgeSnapshot {
  const accessibility = isRecord(raw) && Array.isArray(raw.accessibility)
    ? raw.accessibility.flatMap((node): WebBridgeAccessibilityNode[] => {
      if (!isRecord(node) || typeof node.role !== 'string' || typeof node.name !== 'string' || typeof node.selector !== 'string') return []
      return [{ role: node.role, name: node.name, selector: node.selector, disabled: node.disabled === true }]
    })
    : []
  const accessibilityTree = isRecord(raw) && Array.isArray(raw.accessibilityTree)
    ? raw.accessibilityTree.flatMap((node): WebBridgeAccessibilityNode[] => {
      if (!isRecord(node) || typeof node.role !== 'string' || typeof node.name !== 'string' || typeof node.selector !== 'string') return []
      return [{ role: node.role, name: node.name, selector: node.selector, disabled: node.disabled === true }]
    })
    : []
  return {
    url: typeof url === 'string' ? url : '',
    title: isRecord(raw) && typeof raw.title === 'string' ? raw.title : '',
    text: isRecord(raw) && typeof raw.text === 'string' ? raw.text : '',
    accessibility,
    accessibilityTree,
  }
}

function safeDownloadFileName(contentDisposition: string | null, rawUrl: string): string {
  const fromHeader = contentDisposition?.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i)?.[1]
  const fallback = new URL(rawUrl).pathname.split('/').pop() || 'download'
  const candidate = decodeURIComponent(fromHeader ?? fallback)
  return candidate.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'download'
}

function contentTypeForFileName(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase()
  const types: Record<string, string> = {
    csv: 'text/csv', json: 'application/json', pdf: 'application/pdf', png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    txt: 'text/plain', md: 'text/markdown', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip',
  }
  return extension ? types[extension] ?? 'application/octet-stream' : 'application/octet-stream'
}

function isSafeWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

export function normalizeWebUrl(value: string): string {
  const url = new URL(value)
  if (!isSafeWebUrl(url.toString())) throw new Error('Web Bridge 仅支持 http 或 https 地址')
  if (url.username || url.password) throw new Error('URL 不能包含用户名或密码')
  return url.toString()
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }

export const webBridgeService = new WebBridgeService()
