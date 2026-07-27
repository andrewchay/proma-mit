/** Web Bridge 浏览器自动化后端。工具、权限、审计和 UI 只依赖这一稳定边界。 */

import type { BrowserWindow } from 'electron'
import { Buffer } from 'node:buffer'
import { chromium, type Browser, type Frame, type Page } from 'playwright-core'

const MAX_SNAPSHOT_LENGTH = 16_000

export interface WebBridgeAccessibilityNode {
  elementId: string
  role: string
  name: string
  /** 旧调用兼容字段；新工具调用应使用 elementId。 */
  selector: string
  disabled: boolean
  frameId?: string
}

export interface WebBridgeSnapshot {
  url: string
  title: string
  text: string
  accessibility: WebBridgeAccessibilityNode[]
  accessibilityTree: WebBridgeAccessibilityNode[]
}

export interface WebBridgeScreenshot { data: string; mediaType: 'image/png' }

export interface SelectedUploadFile {
  name: string
  bytes: number
  contentType: string
  data: string
  lastModified: number
}

export interface WebAutomationBackend {
  readonly mode: 'managed' | 'chrome-cdp'
  navigate(url: string): Promise<WebBridgeSnapshot>
  snapshot(): Promise<WebBridgeSnapshot>
  screenshot(): Promise<WebBridgeScreenshot>
  click(target: WebElementTarget): Promise<WebBridgeSnapshot>
  type(target: WebElementTarget, text: string, submit: boolean): Promise<WebBridgeSnapshot>
  scroll(direction: 'up' | 'down', amount: number): Promise<WebBridgeSnapshot>
  setFileInput(target: WebElementTarget, files: SelectedUploadFile[]): Promise<void>
  close(): void | Promise<void>
}

export interface WebElementTarget {
  elementId?: string
  /** 仅用于旧会话和兼容调用；新调用必须使用快照的 element_id。 */
  selector?: string
}

export class ManagedElectronBackend implements WebAutomationBackend {
  readonly mode = 'managed' as const

  constructor(private readonly window: BrowserWindow) {}

  async navigate(url: string): Promise<WebBridgeSnapshot> {
    await this.window.loadURL(url)
    return this.snapshot()
  }

  async snapshot(): Promise<WebBridgeSnapshot> {
    const raw = await this.window.webContents.executeJavaScript(`(${SNAPSHOT_SCRIPT})('main')`, true)
    return snapshotFromRaw(this.window.webContents.getURL(), raw)
  }

  async screenshot(): Promise<WebBridgeScreenshot> {
    const image = await this.window.webContents.capturePage()
    return { data: image.toPNG().toString('base64'), mediaType: 'image/png' }
  }

  async click(target: WebElementTarget): Promise<WebBridgeSnapshot> {
    await this.window.webContents.executeJavaScript(buildClickScript(target), true)
    return this.snapshot()
  }

  async type(target: WebElementTarget, text: string, submit: boolean): Promise<WebBridgeSnapshot> {
    await this.window.webContents.executeJavaScript(buildTypeScript(target, text, submit), true)
    return this.snapshot()
  }

  async scroll(direction: 'up' | 'down', amount: number): Promise<WebBridgeSnapshot> {
    const distance = clampScrollAmount(amount) * (direction === 'down' ? 1 : -1)
    await this.window.webContents.executeJavaScript(`window.scrollBy({ top: ${distance}, behavior: 'instant' })`, true)
    return this.snapshot()
  }

  async setFileInput(target: WebElementTarget, files: SelectedUploadFile[]): Promise<void> {
    await this.window.webContents.executeJavaScript(buildUploadScript(target, files), true)
  }

  close(): void { if (!this.window.isDestroyed()) this.window.close() }
}

/** 只连接用户主动开启的本机 Chrome CDP；不会启动或关闭 Chrome。 */
export class PlaywrightCdpBackend implements WebAutomationBackend {
  readonly mode = 'chrome-cdp' as const

  private constructor(private readonly browser: Browser, private readonly page: Page) {}

  static async connect(port: number, targetId?: string): Promise<PlaywrightCdpBackend> {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true })
    try {
      const page = await findPage(browser, targetId)
      if (!page) throw new Error('未找到可连接的 Chrome 页面')
      return new PlaywrightCdpBackend(browser, page)
    } catch (error) {
      await browser.close()
      throw error
    }
  }

  async navigate(url: string): Promise<WebBridgeSnapshot> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
    return this.snapshot()
  }

  async snapshot(): Promise<WebBridgeSnapshot> {
    const frames = this.page.frames()
    const snapshots = await Promise.all(frames.map(async (frame, index) => ({
      frameId: `frame-${index}`,
      raw: await frame.evaluate(`(${SNAPSHOT_SCRIPT})(${JSON.stringify(`frame-${index}`)})`),
      url: frame.url(),
    })))
    const main = snapshots[0]
    if (!main) throw new Error('Chrome 页面不可用')
    const result = snapshotFromRaw(main.url, main.raw)
    for (const frame of snapshots.slice(1)) {
      const child = snapshotFromRaw(frame.url, frame.raw)
      result.text = `${result.text}\n${child.text}`.slice(0, MAX_SNAPSHOT_LENGTH)
      result.accessibility.push(...child.accessibility.map((node) => ({ ...node, frameId: frame.frameId })))
      result.accessibilityTree.push(...child.accessibilityTree.map((node) => ({ ...node, frameId: frame.frameId })))
    }
    return result
  }

  async screenshot(): Promise<WebBridgeScreenshot> {
    return { data: (await this.page.screenshot({ type: 'png' })).toString('base64'), mediaType: 'image/png' }
  }

  async click(target: WebElementTarget): Promise<WebBridgeSnapshot> {
    const locator = await this.locator(target)
    await locator.waitFor({ state: 'visible' })
    await locator.click()
    return this.snapshot()
  }

  async type(target: WebElementTarget, text: string, submit: boolean): Promise<WebBridgeSnapshot> {
    const locator = await this.locator(target)
    await locator.waitFor({ state: 'visible' })
    await locator.fill(text)
    if (submit) await locator.press('Enter')
    return this.snapshot()
  }

  async scroll(direction: 'up' | 'down', amount: number): Promise<WebBridgeSnapshot> {
    await this.page.evaluate((distance) => window.scrollBy({ top: distance, behavior: 'instant' }), clampScrollAmount(amount) * (direction === 'down' ? 1 : -1))
    return this.snapshot()
  }

  async setFileInput(target: WebElementTarget, files: SelectedUploadFile[]): Promise<void> {
    const locator = await this.locator(target)
    await locator.setInputFiles(files.map((file) => ({ name: file.name, mimeType: file.contentType, buffer: Buffer.from(file.data, 'base64') })))
  }

  async close(): Promise<void> { await this.browser.close() }

  private async locator(target: WebElementTarget) {
    const selector = target.elementId
      ? `[data-proma-web-element-id=${JSON.stringify(target.elementId)}]`
      : target.selector
    if (!selector) throw new Error('必须提供快照中的 element_id')
    for (const frame of this.page.frames()) {
      const locator = frame.locator(selector)
      if (await locator.count() > 0) return locator.first()
    }
    throw new Error(`未找到页面元素: ${target.elementId ?? target.selector}`)
  }
}

async function findPage(browser: Browser, targetId?: string): Promise<Page | undefined> {
  const pages = browser.contexts().flatMap((context) => context.pages())
  if (!targetId) return pages[0]
  for (const page of pages) {
    const session = await page.context().newCDPSession(page)
    try {
      const info = await session.send('Target.getTargetInfo') as { targetInfo?: { targetId?: string } }
      if (info.targetInfo?.targetId === targetId) return page
    } finally {
      await session.detach()
    }
  }
  return undefined
}

function clampScrollAmount(amount: number): number { return Math.min(Math.max(amount, 100), 2_000) }

function targetSelector(target: WebElementTarget): string {
  if (target.elementId) return `[data-proma-web-element-id=${JSON.stringify(target.elementId)}]`
  if (target.selector) return target.selector
  throw new Error('必须提供快照中的 element_id')
}

function buildClickScript(target: WebElementTarget): string {
  return `(() => { const element = document.querySelector(${JSON.stringify(targetSelector(target))}); if (!(element instanceof HTMLElement)) throw new Error('未找到页面元素'); element.click(); })()`
}

function buildTypeScript(target: WebElementTarget, text: string, submit: boolean): string {
  return `(() => { const element = document.querySelector(${JSON.stringify(targetSelector(target))}); if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLElement && element.isContentEditable)) throw new Error('未找到可输入的页面元素'); element.focus(); if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set?.call(element, ${JSON.stringify(text)}); else element.textContent = ${JSON.stringify(text)}; element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} })); element.dispatchEvent(new Event('change', { bubbles: true })); ${submit ? "element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));" : ''} })()`
}

function buildUploadScript(target: WebElementTarget, files: SelectedUploadFile[]): string {
  return `(() => { const input = document.querySelector(${JSON.stringify(targetSelector(target))}); if (!(input instanceof HTMLInputElement) || input.type !== 'file') throw new Error('未找到文件上传控件'); const uploads = ${JSON.stringify(files)}; if (!input.multiple && uploads.length > 1) throw new Error('目标上传控件仅支持单个文件'); const transfer = new DataTransfer(); for (const upload of uploads) { const bytes = Uint8Array.from(atob(upload.data), (character) => character.charCodeAt(0)); transfer.items.add(new File([bytes], upload.name, { type: upload.contentType, lastModified: upload.lastModified })); } input.files = transfer.files; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`
}

const SNAPSHOT_SCRIPT = `(frameId) => { const selectorFor = (element) => { if (element.id) return '#' + CSS.escape(element.id); const name = element.getAttribute('name'); if (name) return element.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]'; const role = element.getAttribute('role'); if (role) return '[role="' + CSS.escape(role) + '"]'; return element.tagName.toLowerCase(); }; let nextId = Number(window.__promaWebBridgeNextElementId || 0); const elementId = (element) => { const existing = element.getAttribute('data-proma-web-element-id'); if (existing) return existing; const value = frameId + '-e-' + (++nextId); window.__promaWebBridgeNextElementId = nextId; element.setAttribute('data-proma-web-element-id', value); return value; }; const visible = (element) => element instanceof HTMLElement && (element.offsetParent !== null || element.getClientRects().length > 0); const nodeFor = (element) => ({ elementId: elementId(element), role: element.getAttribute('role') || element.tagName.toLowerCase(), name: (element.getAttribute('aria-label') || element.innerText || element.getAttribute('placeholder') || element.getAttribute('title') || '').trim().slice(0, 200), selector: selectorFor(element), disabled: 'disabled' in element && Boolean(element.disabled) }); const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]')].filter(visible).slice(0, 200).map(nodeFor); const tree = []; const walk = (element, depth) => { if (!visible(element) || tree.length >= 500 || depth > 6) return; const node = nodeFor(element); if (node.name || ['main', 'nav', 'form', 'dialog', 'button', 'input'].includes(node.role)) tree.push(node); [...element.children].forEach((child) => walk(child, depth + 1)); if (element.shadowRoot) [...element.shadowRoot.children].forEach((child) => walk(child, depth + 1)); }; walk(document.body, 0); return { title: document.title, text: (document.body?.innerText || '').slice(0, 16000), accessibility: elements, accessibilityTree: tree }; }`

function snapshotFromRaw(url: unknown, raw: unknown): WebBridgeSnapshot {
  const parse = (value: unknown): WebBridgeAccessibilityNode[] => Array.isArray(value) ? value.flatMap((node): WebBridgeAccessibilityNode[] => {
    if (!isRecord(node) || typeof node.elementId !== 'string' || typeof node.role !== 'string' || typeof node.name !== 'string' || typeof node.selector !== 'string') return []
    return [{ elementId: node.elementId, role: node.role, name: node.name, selector: node.selector, disabled: node.disabled === true }]
  }) : []
  return { url: typeof url === 'string' ? url : '', title: isRecord(raw) && typeof raw.title === 'string' ? raw.title : '', text: isRecord(raw) && typeof raw.text === 'string' ? raw.text : '', accessibility: isRecord(raw) ? parse(raw.accessibility) : [], accessibilityTree: isRecord(raw) ? parse(raw.accessibilityTree) : [] }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
