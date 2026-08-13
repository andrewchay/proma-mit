/**
 * Browser Engine 控制器（垂直切片：S0-S3 骨架）
 *
 * 目标：在一个宿主窗口中用多个 WebContentsView 承载多标签页，每个标签通过
 * webContents.debugger (CDP) 驱动做结构化 AX 观察与真实输入，供爬虫等任务使用。
 *
 * 本文件是 vertical slice：验证「多标签切换 + CDP AX observe + CDP 真实输入」通路，
 * 暂不改动现有 web-bridge-service。后续再接入工具层与站点信任权限。
 */

import { BrowserWindow, WebContentsView, type NativeImage } from 'electron'
import { withBrowserCdpTimeout, throwIfBrowserOperationAborted, BrowserOperationAbortedError, BROWSER_OBSERVE_TIMEOUT_MS, type CdpCommandFn } from './browser-cdp'
import { assertSafeBrowserUrl } from './browser-policy'
import { parseBrowserPressAction } from './browser-key-policy'
import { resolveBrowserObserveMaxElements, prioritizeBrowserObservationCandidates, browserObservationNameLimit, type BrowserAxCandidate } from './browser-observation-policy'

const MAX_BROWSER_TABS = 20

export interface BrowserTabState {
  tabId: string
  url: string
  title: string
  loading: boolean
  visible: boolean
}

export interface BrowserObservation {
  tabId: string
  url: string
  title: string
  generation: number
  elements: Array<{ ref: string; role: string; name: string; editable: boolean }>
}

type CdpResponse = Record<string, unknown>

interface RefEntry {
  backendNodeId: number
  generation: number
  label: string
  editable: boolean
}

interface BrowserTab {
  tabId: string
  view: WebContentsView
  state: BrowserTabState
  refs: Map<string, RefEntry>
  /** 页面文档/观察代际；导航、关闭、调试器恢复后即失效。 */
  generation: number
  /** 防止同一 Tab 上命令交错下发。 */
  commandTail: Promise<void>
  /** 由 Agent 创建，用于超限时优先回收最久未用者。 */
  openedByAgent: boolean
  lastActivityAt: number
}

interface BrowserSession {
  hostWindow: BrowserWindow
  tabs: Map<string, BrowserTab>
  activeTabId: string
}

export class BrowserController {
  private sessions = new Map<string, BrowserSession>()

  /**
   * 创建一个宿主窗口。垂直切片阶段每个会话一个独立窗口，内部承载多 tab。
   */
  private getOrCreateSession(sessionId: string): BrowserSession {
    const existing = this.sessions.get(sessionId)
    if (existing && !existing.hostWindow.isDestroyed()) {
      existing.hostWindow.show()
      return existing
    }

    const hostWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 720,
      minHeight: 480,
      title: 'Gravitas Browser Engine',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    hostWindow.setMenuBarVisibility(false)
    hostWindow.on('closed', () => this.sessions.delete(sessionId))

    const session: BrowserSession = { hostWindow, tabs: new Map(), activeTabId: '' }
    this.sessions.set(sessionId, session)
    return session
  }

  private emptyTabState(tabId: string): BrowserTabState {
    return { tabId, url: '', title: '新建标签页', loading: false, visible: false }
  }

  private createTab(session: BrowserSession, claimAsAgent = false): BrowserTab {
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })
    // 宿主窗口使用 contentView 承载多个标签；垂直切片这里每个 tab 都挂在 hostIndex 上。
    session.hostWindow.contentView.addChildView(view)
    this.setViewRect(session.hostWindow, view)

    const tab: BrowserTab = {
      tabId,
      view,
      state: this.emptyTabState(tabId),
      refs: new Map(),
      generation: 0,
      commandTail: Promise.resolve(),
      openedByAgent: claimAsAgent,
      lastActivityAt: Date.now(),
    }

    // 站外链接/新窗口：转成当前会话的新标签，不让新建不受管的 BrowserWindow。
    view.webContents.setWindowOpenHandler(({ url }) => {
      void this.openExternalLinkInTab(session, tab, url)
      return { action: 'deny' }
    })

    // 导航前失效 document/ref，避免在新页面用旧坐标操作。
    view.webContents.on('will-navigate', (event, url) => {
      this.invalidateTabDocument(tab)
      try { assertSafeBrowserUrl(url) } catch { event.preventDefault() }
    })
    view.webContents.on('did-start-loading', () => { this.invalidateTabDocument(tab); this.updateTabState(session) })
    view.webContents.on('page-title-updated', () => this.updateTabState(session))
    view.webContents.on('did-navigate', () => { this.invalidateTabDocument(tab); this.updateTabState(session) })
    view.webContents.on('did-navigate-in-page', () => { this.invalidateTabDocument(tab); this.updateTabState(session) })
    view.webContents.on('destroyed', () => {
      if (session.tabs.has(tab.tabId)) session.tabs.delete(tab.tabId)
      if (session.activeTabId === tab.tabId) session.activeTabId = [...session.tabs.keys()][0] ?? ''
    })

    try { view.webContents.debugger.attach('1.3') } catch (error) {
      console.warn('[BrowserEngine] CDP attach 失败:', error)
    }

    session.tabs.set(tabId, tab)
    if (!session.activeTabId) session.activeTabId = tabId
    return tab
  }

  private setViewRect(hostWindow: BrowserWindow, view: WebContentsView): void {
    const { width, height } = hostWindow.getContentBounds()
    view.setBounds({ x: 0, y: 0, width, height })
  }

  private updateTabState(session: BrowserSession): void {
    for (const tab of session.tabs.values()) {
      const url = tab.view.webContents.getURL()
      if (url) tab.state.url = url
      tab.state.title = tab.view.webContents.getTitle() || tab.state.title
      tab.state.visible = tab.tabId === session.activeTabId
    }
  }

  private invalidateTabDocument(tab: BrowserTab): void {
    tab.generation += 1
    tab.refs.clear()
  }

  private enqueueTab<T>(tab: BrowserTab, task: () => Promise<T>): Promise<T> {
    const run = tab.commandTail.then(task, task)
    tab.commandTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async cdp(tab: BrowserTab, method: string, params?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<CdpResponse> {
    throwIfBrowserOperationAborted(signal)
    const debuggerClient = tab.view.webContents.debugger
    if (!debuggerClient.isAttached()) throw new Error('浏览器调试通道不可用。')
    try {
      return await withBrowserCdpTimeout(
        (() => debuggerClient.sendCommand(method, params)) as CdpCommandFn,
        method,
        timeoutMs,
        signal,
      ) as CdpResponse
    } catch (error) {
      // 超时则重连调试通道，避免命令卡住影响后续操作。
      if (error instanceof BrowserOperationAbortedError) throw error
      if (error instanceof Error && error.name === 'BrowserCdpTimeoutError') {
        console.error(`[BrowserEngine] CDP ${method} 超时，尝试重连调试通道。`)
        this.recoverDebugger(tab)
      }
      throw error
    }
  }

  private recoverDebugger(tab: BrowserTab): void {
    this.invalidateTabDocument(tab)
    const debuggerClient = tab.view.webContents.debugger
    try {
      if (debuggerClient.isAttached()) debuggerClient.detach()
      debuggerClient.attach('1.3')
      console.warn('[BrowserEngine] CDP 调试通道已重连。')
    } catch (error) {
      console.warn('[BrowserEngine] CDP 重连失败:', error)
    }
  }

  private assertCurrentDocument(tab: BrowserTab, generation: number): void {
    if (tab.generation !== generation) throw new Error('页面已变化或标签已关闭，请先重新观察。')
  }

  private hideAllTabsExcept(session: BrowserSession, targetTabId: string): void {
    for (const tab of session.tabs.values()) {
      tab.view.setVisible(tab.tabId === targetTabId)
    }
  }

  /** 达到上限时回收最久未用的 Agent 标签，绝不关当前/工作标签。 */
  private reclaimExcessAgentTabs(session: BrowserSession): void {
    const candidates = [...session.tabs.values()]
      .filter((tab) => tab.openedByAgent && tab.tabId !== session.activeTabId)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt)
    while (session.tabs.size > MAX_BROWSER_TABS && candidates.length > 0) {
      const tab = candidates.shift()
      if (!tab || !session.tabs.has(tab.tabId)) continue
      this.disposeTab(session, tab)
    }
  }

  private disposeTab(session: BrowserSession, tab: BrowserTab): void {
    session.tabs.delete(tab.tabId)
    try { tab.view.webContents.close() } catch { /* 已销毁 */ }
    try { session.hostWindow.contentView.removeChildView(tab.view) } catch { /* 已销毁 */ }
  }

  // ---- 公开操作 ----

  /**
   * 新建 Agent 工作标签，并切换为可见（用户能看到接下来的操作）。
   */
  createNewTab(sessionId: string, url?: string, signal?: AbortSignal): BrowserTabState {
    const session = this.getOrCreateSession(sessionId)
    this.reclaimExcessAgentTabs(session)
    const tab = this.createTab(session, true)
    session.activeTabId = tab.tabId
    this.hideAllTabsExcept(session, tab.tabId)
    if (url) void this.loadUrl(session, tab, url, signal)
    this.updateTabState(session)
    return { ...tab.state }
  }

  listTabs(sessionId: string): Array<BrowserTabState> {
    const session = this.getOrCreateSession(sessionId)
    return [...session.tabs.values()].map((tab) => ({ ...tab.state }))
  }

  async selectTab(sessionId: string, tabId: string, signal?: AbortSignal): Promise<BrowserTabState> {
    const session = this.getOrCreateSession(sessionId)
    const tab = session.tabs.get(tabId)
    if (!tab) throw new Error(`未找到标签: ${tabId}`)
    tab.lastActivityAt = Date.now()
    session.activeTabId = tabId
    this.hideAllTabsExcept(session, tabId)
    this.updateTabState(session)
    return { ...tab.state }
  }

  async closeTab(sessionId: string, tabId: string, signal?: AbortSignal): Promise<void> {
    const session = this.getOrCreateSession(sessionId)
    const tab = session.tabs.get(tabId)
    if (!tab) return
    this.disposeTab(session, tab)
    if (!session.activeTabId || session.activeTabId === tabId) {
      session.activeTabId = [...session.tabs.keys()][0] ?? ''
      if (session.activeTabId) this.hideAllTabsExcept(session, session.activeTabId)
    }
    this.updateTabState(session)
  }

  private async loadUrl(session: BrowserSession, tab: BrowserTab, rawUrl: string, signal?: AbortSignal): Promise<void> {
    const url = assertSafeBrowserUrl(rawUrl)
    tab.lastActivityAt = Date.now()
    try {
      await this.cdp(tab, 'Page.navigate', { url })
    } catch (error) {
      throw error
    }
  }

  private getAgentTab(session: BrowserSession, tabId?: string): BrowserTab {
    if (tabId) {
      const tab = session.tabs.get(tabId)
      if (!tab) throw new Error('未找到指定标签。')
      return tab
    }
    const active = session.tabs.get(session.activeTabId)
    if (!active) throw new Error('当前会话没有可用标签。')
    return active
  }

  async navigate(sessionId: string, rawUrl: string, tabId?: string, signal?: AbortSignal): Promise<BrowserObservation> {
    const session = this.getOrCreateSession(sessionId)
    const tab = this.getAgentTab(session, tabId)
    return this.enqueueTab(tab, async () => {
      await this.loadUrl(session, tab, rawUrl, signal)
      this.updateTabState(session)
      return this.observeInternal(session, tab, undefined, signal)
    })
  }

  /**
   * 通过 CDP Accessibility.getFullAXTree 读取结构化元素列表，生成带代际的 ref。
   */
  async observe(sessionId: string, tabId?: string, requestedMaxElements?: number, signal?: AbortSignal): Promise<BrowserObservation> {
    const session = this.getOrCreateSession(sessionId)
    const tab = this.getAgentTab(session, tabId)
    return this.enqueueTab(tab, () => this.observeInternal(session, tab, requestedMaxElements, signal))
  }

  private async observeInternal(session: BrowserSession, tab: BrowserTab, requestedMaxElements?: number, signal?: AbortSignal): Promise<BrowserObservation> {
    throwIfBrowserOperationAborted(signal)
    const maxElements = resolveBrowserObserveMaxElements(requestedMaxElements)
    // 限制 AX 树深度避免整树序列化阻塞；垂直切片用固定深度 8。
    const response = await this.cdp(tab, 'Accessibility.getFullAXTree', { depth: 8 }, BROWSER_OBSERVE_TIMEOUT_MS, signal)
    const nodes = Array.isArray(response.nodes) ? response.nodes : []

    const candidates: BrowserAxCandidate[] = []
    for (const raw of nodes) {
      if (!raw || typeof raw !== 'object') continue
      const node = raw as Record<string, unknown>
      const backendNodeId = typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : 0
      const role = textValue(node.role)
      const name = textValue(node.name)
      const editable = isEditableAxNode(node)
      if (!backendNodeId || !role || (!name && !editable && !isCoreActionableRole(role))) continue
      candidates.push({ backendNodeId, role, name: name.slice(0, browserObservationNameLimit(role)), editable })
    }

    const selected = prioritizeBrowserObservationCandidates(candidates, maxElements)
    tab.generation += 1
    tab.refs.clear()
    const elements: BrowserObservation['elements'] = []
    for (const candidate of selected) {
      const ref = `r${tab.generation}-${elements.length + 1}`
      tab.refs.set(ref, {
        backendNodeId: candidate.backendNodeId,
        generation: tab.generation,
        label: candidate.name ? `${candidate.role}「${candidate.name.slice(0, 80)}」` : candidate.role,
        editable: candidate.editable,
      })
      elements.push({ ref, role: candidate.role, name: candidate.name, editable: candidate.editable })
    }
    this.updateTabState(session)
    return { tabId: tab.tabId, url: getWebUrl(tab), title: tab.state.title, generation: tab.generation, elements }
  }

  /**
   * 用 CDP Input.dispatchMouseEvent 做「真实」点击。
   */
  async click(sessionId: string, ref: string, tabId?: string, signal?: AbortSignal): Promise<BrowserObservation> {
    const session = this.getOrCreateSession(sessionId)
    const tab = this.getAgentTab(session, tabId)
    return this.enqueueTab(tab, async () => {
      const generation = tab.generation
      // 校验 ref 存在且代际有效；实际坐标由 centerForRef（内部也 resolveRef）取得。
      this.resolveRef(tab, ref)
      const { x, y } = await this.centerForRef(tab, ref, generation)
      this.assertCurrentDocument(tab, generation)
      await this.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, undefined, signal)
      this.assertCurrentDocument(tab, generation)
      await this.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, undefined, signal)
      return this.observeInternal(session, tab, undefined, signal)
    })
  }

  /**
   * 用 CDP DOM.focus + Input.insertText 做「真实」填表（整段替换）。
   */
  async fill(sessionId: string, ref: string, text: string, tabId?: string, signal?: AbortSignal): Promise<BrowserObservation> {
    if (text.length > 10_000) throw new Error('单次输入不能超过 10000 个字符。')
    const session = this.getOrCreateSession(sessionId)
    const tab = this.getAgentTab(session, tabId)
    return this.enqueueTab(tab, async () => {
      const generation = tab.generation
      const target = this.resolveRef(tab, ref)
      if (!target.editable) throw new Error('目标元素不是可编辑字段，请重新观察。')
      await this.cdp(tab, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId }, undefined, signal)
      this.assertCurrentDocument(tab, generation)
      await this.cdp(tab, 'DOM.focus', { backendNodeId: target.backendNodeId }, undefined, signal)
      this.assertCurrentDocument(tab, generation)
      // 平台相关的 select-all 修饰键：darwin=4(command), else=2(ctrl)
      const selectAllModifier = process.platform === 'darwin' ? 4 : 2
      await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: selectAllModifier }, undefined, signal)
      this.assertCurrentDocument(tab, generation)
      await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: selectAllModifier }, undefined, signal)
      this.assertCurrentDocument(tab, generation)
      await this.cdp(tab, 'Input.insertText', { text }, undefined, signal)
      return this.observeInternal(session, tab, undefined, signal)
    })
  }

  /**
   * Press：导航键走 Input.dispatchKeyEvent（带 windowsVirtualKeyCode），文本走 Input.insertText。
   */
  async press(sessionId: string, key: string, tabId?: string, signal?: AbortSignal): Promise<BrowserObservation> {
    const action = parseBrowserPressAction(key)
    const session = this.getOrCreateSession(sessionId)
    const tab = this.getAgentTab(session, tabId)
    return this.enqueueTab(tab, async () => {
      if (action.kind === 'key') {
        const keyEvent = { key: action.key, code: action.code, windowsVirtualKeyCode: action.windowsVirtualKeyCode }
        await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keyEvent }, undefined, signal)
        await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...keyEvent }, undefined, signal)
      } else {
        await this.cdp(tab, 'Input.insertText', { text: action.text }, undefined, signal)
      }
      return this.observeInternal(session, tab, undefined, signal)
    })
  }

  private resolveRef(tab: BrowserTab, ref: string): RefEntry {
    const entry = tab.refs.get(ref)
    if (!entry || entry.generation !== tab.generation) throw new Error('元素引用已失效，请先重新观察页面。')
    return entry
  }

  private async centerForRef(tab: BrowserTab, ref: string, generation: number): Promise<{ x: number; y: number }> {
    this.assertCurrentDocument(tab, generation)
    const { backendNodeId } = this.resolveRef(tab, ref)
    await this.cdp(tab, 'DOM.scrollIntoViewIfNeeded', { backendNodeId })
    this.assertCurrentDocument(tab, generation)
    const box = await this.cdp(tab, 'DOM.getBoxModel', { backendNodeId })
    this.assertCurrentDocument(tab, generation)
    const model = box.model as Record<string, unknown> | undefined
    const raw = Array.isArray(model?.content) ? model.content : []
    if (raw.length < 8 || !raw.every((v) => typeof v === 'number')) throw new Error('目标元素当前不可点击，请重新观察页面。')
    const quad = raw as number[]
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4
    return { x, y }
  }

  /** 站外链接转为新 Agent 标签打开。 */
  private async openExternalLinkInTab(session: BrowserSession, sourceTab: BrowserTab, url: string): Promise<void> {
    try { assertSafeBrowserUrl(url) } catch { return }
    const tab = this.createTab(session, true)
    tab.generation = sourceTab.generation + 1
    session.activeTabId = tab.tabId
    this.hideAllTabsExcept(session, tab.tabId)
    await this.loadUrl(session, tab, url)
    this.updateTabState(session)
  }

  screenshot(sessionId: string, tabId?: string, signal?: AbortSignal): Promise<NativeImage> {
    const session = this.getOrCreateSession(sessionId)
    const tab = this.getAgentTab(session, tabId)
    throwIfBrowserOperationAborted(signal)
    return tab.view.webContents.capturePage()
  }

  /**
   * 滚动当前工作 tab。导航键无法滚动 SPA 内部容器时用于兜底。
   */
  async scroll(sessionId: string, direction: 'up' | 'down', amount: number, tabId?: string, signal?: AbortSignal): Promise<void> {
    const session = this.getOrCreateSession(sessionId)
    const tab = this.getAgentTab(session, tabId)
    const distance = clampScroll(browserNormalizeScrollAmount(amount)) * (direction === 'down' ? 1 : -1)
    return this.enqueueTab(tab, async () => {
      await this.cdp(tab, 'Runtime.evaluate', { expression: `window.scrollBy({ top: ${distance}, behavior: 'instant' })`, returnByValue: true }, undefined, signal)
    })
  }

  /**
   * DOM 快照：读取整页可见文本（保留给 WebBridgeSnapshot；Observe 走 AX）。
   */
  async snapshotDom(sessionId: string, tabId?: string, signal?: AbortSignal): Promise<{ url: string; title: string; text: string }> {
    const session = this.getOrCreateSession(sessionId)
    const tab = this.getAgentTab(session, tabId)
    return this.enqueueTab(tab, async () => {
      const expression = `JSON.stringify({ title: document.title, text: (document.body?.innerText || '').slice(0, 16000) })`
      const response = await this.cdp(tab, 'Runtime.evaluate', { expression, returnByValue: true }, undefined, signal)
      const result = response.result as Record<string, unknown> | undefined
      const value = result?.value
      let parsed: { title?: string; text?: string } = {}
      if (typeof value === 'string') { try { parsed = JSON.parse(value) as { title?: string; text?: string } } catch { parsed = {} } }
      return { url: getWebUrl(tab), title: parsed.title ?? tab.state.title, text: parsed.text ?? '' }
    })
  }

  /**
   * 向当前工作 tab 注入上传脚本（文件内容已由系统选择器取得，不落盘、不暴露路径）。
   */
  async setFileInput(sessionId: string, selector: string, files: Array<{ name: string; mimeType: string; base64: string; lastModified: number }>, tabId?: string, signal?: AbortSignal): Promise<void> {
    const session = this.getOrCreateSession(sessionId)
    const tab = this.getAgentTab(session, tabId)
    return this.enqueueTab(tab, async () => {
      const payload = JSON.stringify(files.map((f) => ({ name: f.name, type: f.mimeType, data: f.base64, lastModified: f.lastModified })))
      const script = buildUploadScript(selector, payload)
      const response = await this.cdp(tab, 'Runtime.evaluate', { expression: script, returnByValue: true }, undefined, signal)
      if (response.exceptionDetails) throw new Error('文件上传失败：未找到上传控件或写入失败')
    })
  }

  /**
   * 在当前页面上下文执行表达式并取回 JSON 值（垂直切片验证用途）。
   *
   * 注意：仅用于本地验证/受控脚本，生产接入时应受 browser-script-policy 约束，
   * 不执行页面文本或第三方提供的脚本。
   */
  async evaluateForTest(tabId: string, expression: string, signal?: AbortSignal): Promise<string | number | boolean | null> {
    for (const session of this.sessions.values()) {
      const tab = session.tabs.get(tabId)
      if (!tab) continue
      return this.enqueueTab(tab, async () => {
        const response = await this.cdp(tab, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, undefined, signal)
        const result = response.result as Record<string, unknown> | undefined
        if (response.exceptionDetails) throw new Error('页面脚本执行失败')
        const value = result?.value
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) return value
        return null
      })
    }
    throw new Error(`未找到标签: ${tabId}`)
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    for (const tab of [...session.tabs.values()]) this.disposeTab(session, tab)
    if (!session.hostWindow.isDestroyed()) session.hostWindow.close()
    this.sessions.delete(sessionId)
  }
}

// ---- 辅助函数 ----

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && 'value' in value && typeof (value as Record<string, unknown>).value === 'string') {
    return (value as Record<string, unknown>).value as string
  }
  return ''
}

function isEditableAxNode(ax: Record<string, unknown>): boolean {
  const role = textValue(ax.role).toLowerCase()
  if (role === 'textbox' || role === 'searchbox') return true
  // Chromium 把 contenteditable 表示为 editable=true，也可能是 token: richtext/plaintext。
  const properties = Array.isArray(ax.properties) ? ax.properties : []
  return properties.some((property) => {
    if (!property || typeof property !== 'object') return false
    const record = property as Record<string, unknown>
    if (record.name !== 'editable' || !record.value || typeof record.value !== 'object') return false
    const value = (record.value as Record<string, unknown>).value
    return value === true || (typeof value === 'string' && value !== '' && value !== 'false')
  })
}

const CORE_ACTIONABLE_ROLES = new Set(['button', 'textbox', 'link', 'checkbox', 'combobox'])

function isCoreActionableRole(role: string): boolean {
  return CORE_ACTIONABLE_ROLES.has(role.toLowerCase())
}

function getWebUrl(tab: BrowserTab): string {
  try { return tab.view.webContents.getURL() } catch { return '' }
}

function clampScroll(value: number): number { return Math.min(Math.max(value, -2000), 2000) }
function browserNormalizeScrollAmount(amount: number): number { return Math.min(Math.max(amount, 100), 2000) }

/** 生成把文件注入到指定 file input 的脚本；data 按 base64 传，避免把路径/内容当代码执行。 */
function buildUploadScript(selector: string, payloadJson: string): string {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const input = document.querySelector(selector);
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') throw new Error('未找到文件上传控件');
    const uploads = ${payloadJson};
    if (!input.multiple && uploads.length > 1) throw new Error('目标上传控件仅支持单个文件');
    const transfer = new DataTransfer();
    for (const u of uploads) {
      const bytes = Uint8Array.from(atob(u.data), (c) => c.charCodeAt(0));
      transfer.items.add(new File([bytes], u.name, { type: u.type, lastModified: u.lastModified }));
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`
}

export const browserController = new BrowserController()
