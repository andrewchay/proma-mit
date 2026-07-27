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
import { getConfigDir } from './config-paths'
import {
  ManagedElectronBackend,
  PlaywrightCdpBackend,
  type SelectedUploadFile,
  type WebAutomationBackend,
  type WebBridgeScreenshot,
  type WebBridgeSnapshot,
  type WebElementTarget,
} from './web-automation-backend'

export type {
  WebBridgeAccessibilityNode,
  WebBridgeScreenshot,
  WebBridgeSnapshot,
} from './web-automation-backend'

const WEB_BRIDGE_PARTITION_PREFIX = 'persist:proma-web-bridge-'
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_UPLOAD_FILES = 10

export interface WebBridgeDownload {
  filePath: string
  bytes: number
  contentType: string
}

/** 上传结果不包含原始绝对路径，避免将用户本地目录暴露给 Agent。 */
export interface WebBridgeUpload {
  files: Array<{ name: string; bytes: number; contentType: string }>
}

interface WebBridgeSession {
  window?: BrowserWindow
  backend?: WebAutomationBackend
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
    const backend = this.getOrCreateManagedBackend(sessionId)
    return this.rememberSnapshot(sessionId, await backend.navigate(url))
  }

  async snapshot(sessionId: string): Promise<WebBridgeSnapshot> {
    const backend = this.requireBackend(sessionId)
    return this.rememberSnapshot(sessionId, await backend.snapshot())
  }

  async screenshot(sessionId: string): Promise<WebBridgeScreenshot> {
    return this.requireBackend(sessionId).screenshot()
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
  async selectAndUpload(sessionId: string, target: WebElementTarget): Promise<WebBridgeUpload> {
    this.requireActiveSession(sessionId)
    const owner = this.sessions.get(sessionId)?.window ?? electron.BrowserWindow.getFocusedWindow()
    const result = owner
      ? await electron.dialog.showOpenDialog(owner, { title: '选择要上传到当前网页的文件', properties: ['openFile', 'multiSelections'] })
      : await electron.dialog.showOpenDialog({ title: '选择要上传到当前网页的文件', properties: ['openFile', 'multiSelections'] })
    if (result.canceled || result.filePaths.length === 0) throw new Error('用户取消了文件上传')
    if (result.filePaths.length > MAX_UPLOAD_FILES) throw new Error(`单次最多上传 ${MAX_UPLOAD_FILES} 个文件`)

    const files = await this.readSelectedUploadFiles(result.filePaths)
    await this.requireBackend(sessionId).setFileInput(target, files)
    return { files: files.map(({ name, bytes, contentType }) => ({ name, bytes, contentType })) }
  }

  async click(sessionId: string, target: WebElementTarget): Promise<WebBridgeSnapshot> {
    return this.rememberSnapshot(sessionId, await this.requireBackend(sessionId).click(target))
  }

  async type(sessionId: string, target: WebElementTarget, text: string, submit: boolean): Promise<WebBridgeSnapshot> {
    return this.rememberSnapshot(sessionId, await this.requireBackend(sessionId).type(target, text, submit))
  }

  async scroll(sessionId: string, direction: 'up' | 'down', amount: number): Promise<WebBridgeSnapshot> {
    return this.rememberSnapshot(sessionId, await this.requireBackend(sessionId).scroll(direction, amount))
  }

  close(sessionId: string): void {
    const current = this.sessions.get(sessionId)
    if (!current) return
    this.sessions.delete(sessionId)
    void current.backend?.close()
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
      mode: current.backend?.mode,
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
    const backend = await PlaywrightCdpBackend.connect(port, target.id)
    this.sessions.set(sessionId, { backend })
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
    this.sessions.set(sessionId, { window, backend: new ManagedElectronBackend(window) })
    return window
  }

  private getOrCreateManagedBackend(sessionId: string): WebAutomationBackend {
    const current = this.sessions.get(sessionId)
    if (current?.backend) return current.backend
    this.getOrCreateWindow(sessionId)
    return this.requireBackend(sessionId)
  }

  private requireBackend(sessionId: string): WebAutomationBackend {
    const backend = this.sessions.get(sessionId)?.backend
    if (!backend) throw new Error('当前会话尚未打开 Web Bridge；请先使用 WebBridgeNavigate 或 WebBridgeConnectChrome')
    return backend
  }

  private requireActiveSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) throw new Error('当前会话尚未打开 Web Bridge；请先使用 WebBridgeNavigate 或 WebBridgeConnectChrome')
  }

  private rememberSnapshot(sessionId: string, snapshot: WebBridgeSnapshot): WebBridgeSnapshot {
    const current = this.sessions.get(sessionId)
    if (current) current.lastSnapshot = snapshot
    return snapshot
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

}

async function listChromeTargets(port: number): Promise<ChromeTarget[]> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Chrome 调试端口必须在 1024 到 65535 之间')
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) throw new Error(`无法连接 Chrome 调试端口 ${port}`)
  const data = await response.json()
  if (!Array.isArray(data)) throw new Error('Chrome 返回了无效的页面列表')
  return data.filter((item): item is ChromeTarget => isRecord(item) && item.type === 'page' && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.url === 'string')
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
