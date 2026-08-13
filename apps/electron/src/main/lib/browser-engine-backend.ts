/**
 * BrowserEngineBackend：把 browser-engine（多标签 CDP）适配为 WebAutomationBackend。
 *
 * 设计：这是「替换底层」的桥梁——
 *  - mode=managed，内部委托给 browserController（多 tab WebContentsView + CDP）。
 *  - 单 tab 语义的接口方法（navigate/snapshot/click/type/scroll/setFileInput）
 *    委托到「当前工作 tab」；多标签方法（createNewTab/listTabs/selectTab/closeTab）
 *    直接透传，供新增的 WebBridge 多标签工具使用。
 *  - 元素定位归一：click/type 优先用 AX ref（来自 WebBridgeObserve）；element_id/selector
 *    回退到 DOM 脚本定位（兼容旧会话）。
 */

import type { BrowserController } from './browser-engine/browser-controller'
import type { SelectedUploadFile, WebAutomationBackend, WebBridgeScreenshot, WebBridgeSnapshot, WebElementTarget } from './web-automation-backend'

const MAX_SNAPSHOT_LENGTH = 16_000

export interface BrowserEngineTab {
  tabId: string
  url: string
  title: string
  visible: boolean
}

/**
 * 把 AX observe 的元素（ref/role/name/editable）映射为 WebBridgeSnapshot 兼容结构。
 */
function observationToSnapshot(
  obs: { tabId: string; url: string; title: string; elements: Array<{ ref: string; role: string; name: string; editable: boolean }> },
  text: string,
): WebBridgeSnapshot {
  return {
    url: obs.url,
    title: obs.title,
    text: text.slice(0, MAX_SNAPSHOT_LENGTH),
    accessibility: obs.elements.map((e) => ({
      elementId: e.ref,
      role: e.role,
      name: e.name,
      selector: e.ref,
      disabled: false,
    })),
    accessibilityTree: obs.elements.map((e) => ({
      elementId: e.ref,
      role: e.role,
      name: e.name,
      selector: e.ref,
      disabled: false,
    })),
  }
}

export class BrowserEngineBackend implements WebAutomationBackend {
  readonly mode = 'managed' as const

  constructor(
    private readonly sessionId: string,
    private readonly controller: BrowserController,
  ) {}

  private currentTabId?: string

  private ensureTab(): void {
    if (this.currentTabId && this.controller.listTabs(this.sessionId).some((t) => t.tabId === this.currentTabId)) return
    const tabs = this.controller.listTabs(this.sessionId)
    if (tabs.length === 0) {
      const state = this.controller.createNewTab(this.sessionId)
      this.currentTabId = state.tabId
    } else {
      this.currentTabId = tabs[0]!.tabId
    }
  }

  async navigate(url: string): Promise<WebBridgeSnapshot> {
    this.ensureTab()
    const obs = await this.controller.navigate(this.sessionId, url, this.currentTabId)
    this.currentTabId = obs.tabId
    return this.snapshot()
  }

  async snapshot(): Promise<WebBridgeSnapshot> {
    this.ensureTab()
    const obs = await this.controller.observe(this.sessionId, this.currentTabId)
    this.currentTabId = obs.tabId
    const dom = await this.controller.snapshotDom(this.sessionId, obs.tabId)
    return observationToSnapshot(obs, dom.text)
  }

  async screenshot(): Promise<WebBridgeScreenshot> {
    this.ensureTab()
    const image = await this.controller.screenshot(this.sessionId, this.currentTabId)
    return { data: image.toPNG().toString('base64'), mediaType: 'image/png' }
  }

  /**
   * 纯 AX ref 点击（元素定位只用 WebBridgeObserve 返回的 ref）。
   * 不实现旧 DOM element_id/selector 回退。
   */
  async click(target: WebElementTarget): Promise<WebBridgeSnapshot> {
    const ref = target.elementId ?? target.selector
    if (!ref || !ref.startsWith('r')) {
      throw new Error('当前引擎仅支持 AX ref 定位：请先调用 WebBridgeObserve 获取元素 ref，再传入 click 的 element_id 字段。')
    }
    return this.snapshotOf(await this.controller.click(this.sessionId, ref, this.currentTabId))
  }

  /**
   * 纯 AX ref 输入（元素定位只用 WebBridgeObserve 返回的 ref）。
   */
  async type(target: WebElementTarget, text: string, submit: boolean): Promise<WebBridgeSnapshot> {
    const ref = target.elementId ?? target.selector
    if (!ref || !ref.startsWith('r')) {
      throw new Error('当前引擎仅支持 AX ref 定位：请先调用 WebBridgeObserve 获取元素 ref，再传入 type 的 element_id 字段。')
    }
    await this.snapshotOf(await this.controller.fill(this.sessionId, ref, text, this.currentTabId))
    if (submit) await this.controller.press(this.sessionId, 'Enter', this.currentTabId)
    return this.snapshot()
  }

  async scroll(direction: 'up' | 'down', amount: number): Promise<WebBridgeSnapshot> {
    await this.controller.scroll(this.sessionId, direction, amount, this.currentTabId)
    return this.snapshot()
  }

  async setFileInput(target: WebElementTarget, files: SelectedUploadFile[]): Promise<void> {
    const selector = target.selector
    if (!selector) throw new Error('上传需要 CSS selector 定位文件输入框')
    await this.controller.setFileInput(
      this.sessionId,
      selector,
      files.map((f) => ({ name: f.name, mimeType: f.contentType, base64: f.data, lastModified: f.lastModified })),
      this.currentTabId,
    )
  }

  close(): void | Promise<void> { /* browser-controller 的 close 由 service 统一管理 */ }

  // ---- 多标签（新增工具透传） ----
  createNewTab(url?: string): BrowserEngineTab {
    const state = this.controller.createNewTab(this.sessionId, url)
    this.currentTabId = state.tabId
    return { tabId: state.tabId, url: state.url, title: state.title, visible: state.visible }
  }

  listTabs(): BrowserEngineTab[] {
    return this.controller.listTabs(this.sessionId).map((s) => ({ tabId: s.tabId, url: s.url, title: s.title, visible: s.visible }))
  }

  async selectTab(tabId: string): Promise<BrowserEngineTab> {
    const state = await this.controller.selectTab(this.sessionId, tabId)
    this.currentTabId = state.tabId
    return { tabId: state.tabId, url: state.url, title: state.title, visible: state.visible }
  }

  async closeTab(tabId: string): Promise<void> {
    await this.controller.closeTab(this.sessionId, tabId)
    if (this.currentTabId === tabId) {
      const tabs = this.controller.listTabs(this.sessionId)
      this.currentTabId = tabs[0]?.tabId
    }
  }

  // 新观察：AX 结构化元素
  async observeElements(): Promise<{ tabId: string; url: string; title: string; elements: Array<{ ref: string; role: string; name: string; editable: boolean }> }> {
    this.ensureTab()
    const obs = await this.controller.observe(this.sessionId, this.currentTabId)
    this.currentTabId = obs.tabId
    return obs
  }

  private async snapshotOf(obs: { tabId: string; url: string; title: string; elements: Array<{ ref: string; role: string; name: string; editable: boolean }> }): Promise<WebBridgeSnapshot> {
    const dom = await this.controller.snapshotDom(this.sessionId, obs.tabId)
    return observationToSnapshot(obs, dom.text)
  }
}
