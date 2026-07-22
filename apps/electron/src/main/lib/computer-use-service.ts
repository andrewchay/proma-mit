/** 系统级 Computer Use 服务。 */

import * as electron from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ComputerUsePermissionStatus {
  supported: boolean
  accessibility: boolean
  screenRecording: boolean
  message: string
}
export interface ComputerUsePlatformCapabilities { platform: NodeJS.Platform; screenshot: boolean; input: boolean; frontmostWindow: boolean; message: string }

export interface ComputerUseScreenshot {
  data: string
  mediaType: 'image/png'
  width: number
  height: number
  displayId: string
  scaleFactor: number
  coordinateScale: number
}
const MAX_SCREENSHOT_EDGE = 1600

export interface ComputerUseDisplay {
  id: string
  label: string
  width: number
  height: number
  x: number
  y: number
  scaleFactor: number
  primary: boolean
}

export interface ComputerUseFrontmostApplication {
  name: string
  bundleId: string
  pid: number
}
export interface ComputerUseFrontmostWindow { title: string; x: number; y: number; width: number; height: number }

interface ComputerUseNativeModule {
  status(): { accessibility: boolean; screenRecording: boolean }
  requestPermissions(): { accessibility: boolean; screenRecording: boolean }
  frontmostApplication(): ComputerUseFrontmostApplication
  frontmostWindow(): ComputerUseFrontmostWindow
  click(input: { x: number; y: number }): void
  move(input: { x: number; y: number }): void
  doubleClick(input: { x: number; y: number }): void
  drag(input: { fromX: number; fromY: number; toX: number; toY: number }): void
  keyCombo(input: { keyCode: number; modifiers: number }): void
  type(input: { text: string }): void
  scroll(input: { direction: 'up' | 'down'; amount: number }): void
}

class ComputerUseService {
  private nativeModule: ComputerUseNativeModule | null = null
  getCapabilities(): ComputerUsePlatformCapabilities { return process.platform === 'darwin' ? { platform: process.platform, screenshot: true, input: true, frontmostWindow: true, message: 'macOS 原生 Computer Use 可用' } : { platform: process.platform, screenshot: false, input: false, frontmostWindow: false, message: '当前平台仅完成接口与打包降级，尚未提供原生控制实现' } }

  async getStatus(): Promise<ComputerUsePermissionStatus> {
    if (process.platform !== 'darwin') return { supported: false, accessibility: false, screenRecording: false, message: '当前版本仅支持 macOS Computer Use' }
    const status = this.getNativeModule().status()
    return { supported: true, ...status, message: '已读取 macOS Computer Use 权限状态' }
  }

  async requestPermissions(): Promise<ComputerUsePermissionStatus> {
    this.ensureMacOS()
    const status = this.getNativeModule().requestPermissions()
    return { supported: true, ...status, message: '已请求 macOS 辅助功能与屏幕录制授权，请在系统设置中完成确认后重试' }
  }

  getFrontmostApplication(): ComputerUseFrontmostApplication {
    this.ensureMacOS()
    return this.getNativeModule().frontmostApplication()
  }
  getFrontmostWindow(): ComputerUseFrontmostWindow { this.ensureMacOS(); return this.getNativeModule().frontmostWindow() }

  getDisplays(): ComputerUseDisplay[] {
    this.ensureMacOS()
    const primaryDisplayId = electron.screen.getPrimaryDisplay().id
    return electron.screen.getAllDisplays().map((display) => ({
      id: display.id.toString(),
      label: display.label || `显示器 ${display.id}`,
      width: Math.round(display.size.width),
      height: Math.round(display.size.height),
      x: Math.round(display.bounds.x),
      y: Math.round(display.bounds.y),
      scaleFactor: display.scaleFactor,
      primary: display.id === primaryDisplayId,
    }))
  }

  async screenshot(displayId?: string): Promise<ComputerUseScreenshot> {
    this.ensureMacOS()
    const status = await this.getStatus()
    if (!status.screenRecording) throw new Error('需要在 macOS 系统设置中允许 Proma 进行屏幕录制')
    const display = this.resolveDisplay(displayId)
    // 使用 Electron 的逻辑坐标（DIP）生成截图，使模型看到的像素坐标能直接传给 CGEvent。
    const largestEdge = Math.max(display.size.width, display.size.height)
    const scale = Math.min(1, MAX_SCREENSHOT_EDGE / largestEdge)
    const thumbnailSize = { width: Math.max(1, Math.round(display.size.width * scale)), height: Math.max(1, Math.round(display.size.height * scale)) }
    const sources = await electron.desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
    const source = sources.find((candidate) => candidate.display_id === display.id.toString())
    if (!source || source.thumbnail.isEmpty()) throw new Error(`无法获取显示器 ${display.id} 的截图`)
    const imageSize = source.thumbnail.getSize()
    return {
      data: source.thumbnail.toPNG().toString('base64'),
      mediaType: 'image/png',
      width: imageSize.width,
      height: imageSize.height,
      displayId: display.id.toString(),
      scaleFactor: display.scaleFactor,
      coordinateScale: imageSize.width / display.size.width,
    }
  }

  async click(x: number, y: number, displayId?: string): Promise<string> {
    const display = this.resolveDisplay(displayId)
    if (x < 0 || y < 0 || x >= display.size.width || y >= display.size.height) {
      throw new Error(`坐标必须位于显示器 ${display.id} 的范围内（${Math.round(display.size.width)} × ${Math.round(display.size.height)}）`)
    }
    const globalX = display.bounds.x + x
    const globalY = display.bounds.y + y
    this.getNativeModule().click({ x: globalX, y: globalY })
    return `已点击显示器 ${display.id} 的坐标 (${Math.round(x)}, ${Math.round(y)})`
  }
  async move(x: number, y: number, displayId?: string): Promise<string> { const point = this.toGlobalPoint(x, y, displayId); this.getNativeModule().move(point); return `已移动到 (${Math.round(x)}, ${Math.round(y)})` }
  async doubleClick(x: number, y: number, displayId?: string): Promise<string> { const point = this.toGlobalPoint(x, y, displayId); this.getNativeModule().doubleClick(point); return `已双击 (${Math.round(x)}, ${Math.round(y)})` }
  async drag(fromX: number, fromY: number, toX: number, toY: number, displayId?: string): Promise<string> { const from = this.toGlobalPoint(fromX, fromY, displayId); const to = this.toGlobalPoint(toX, toY, displayId); this.getNativeModule().drag({ fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }); return '已完成拖拽' }
  async keyCombo(key: string, modifiers: string[]): Promise<string> { const keyCode = KEY_CODES[key]; if (keyCode === undefined || modifiers.some((modifier) => !MODIFIERS[modifier])) throw new Error('不支持的快捷键组合'); const flags = modifiers.reduce((value, modifier) => value | MODIFIERS[modifier]!, 0); this.getNativeModule().keyCombo({ keyCode, modifiers: flags }); return `已发送快捷键 ${[...modifiers, key].join('+')}` }
  async type(text: string): Promise<string> { this.getNativeModule().type({ text }); return '已向当前焦点输入文本' }
  async scroll(direction: 'up' | 'down', amount: number): Promise<string> { this.getNativeModule().scroll({ direction, amount }); return `已向${direction}滚动 ${amount} 像素` }

  private ensureMacOS(): void {
    if (process.platform !== 'darwin') throw new Error('当前版本仅支持 macOS Computer Use')
  }

  private resolveDisplay(displayId?: string): Electron.Display {
    if (!displayId) return electron.screen.getPrimaryDisplay()
    const display = electron.screen.getAllDisplays().find((candidate) => candidate.id.toString() === displayId)
    if (!display) throw new Error(`未找到显示器 ${displayId}`)
    return display
  }

  private toGlobalPoint(x: number, y: number, displayId?: string): { x: number; y: number } {
    const display = this.resolveDisplay(displayId)
    if (x < 0 || y < 0 || x >= display.size.width || y >= display.size.height) throw new Error(`坐标必须位于显示器 ${display.id} 的范围内`)
    return { x: display.bounds.x + x, y: display.bounds.y + y }
  }

  private nativeModulePath(): string {
    const resourcesDir = electron.app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
    return join(resourcesDir, 'computer-use', 'macos', 'computer_use.node')
  }

  private getNativeModule(): ComputerUseNativeModule {
    this.ensureMacOS()
    if (this.nativeModule) return this.nativeModule
    const modulePath = this.nativeModulePath()
    if (!existsSync(modulePath)) throw new Error('Computer Use 原生模块未就绪，请重新构建 Proma')
    // 原生模块必须加载进 Electron 主进程，才能使用 Proma 自身获得的 macOS TCC 授权。
    const loaded: unknown = require(modulePath)
    if (!isComputerUseNativeModule(loaded)) throw new Error('Computer Use 原生模块接口无效')
    this.nativeModule = loaded
    return loaded
  }
}

function isComputerUseNativeModule(value: unknown): value is ComputerUseNativeModule {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.status === 'function'
    && typeof candidate.requestPermissions === 'function'
    && typeof candidate.frontmostApplication === 'function'
    && typeof candidate.frontmostWindow === 'function'
    && typeof candidate.click === 'function'
    && typeof candidate.move === 'function'
    && typeof candidate.doubleClick === 'function'
    && typeof candidate.drag === 'function'
    && typeof candidate.keyCombo === 'function'
    && typeof candidate.type === 'function'
    && typeof candidate.scroll === 'function'
}

const KEY_CODES: Record<string, number> = { a: 0, c: 8, v: 9, x: 7, z: 6, f: 3, tab: 48, enter: 36, escape: 53, left: 123, right: 124, down: 125, up: 126 }
const MODIFIERS: Record<string, number> = { command: 1 << 20, shift: 1 << 17, option: 1 << 19, control: 1 << 18 }

export const computerUseService = new ComputerUseService()
