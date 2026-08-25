/**
 * 共享 Electron Mock（测试专用）
 *
 * 背景：项目在纯 Bun/单测进程（无真实 Electron runtime）下运行测试。多个测试文件
 * 曾各自 `mock.module('electron', 残缺内容)`，而 Bun 的 `mock.module` 是**进程级
 * 全局生效 + 最后一次注册覆盖先前**的语义（实测：A 文件的 mock 会被 B 文件的覆盖）。
 * 这导致全量并发/串行时，任何文件依赖的 electron 导出可能被另一个文件的残缺 mock
 * 顶掉，报 `Export named 'xxx' not found` 崩溃。
 *
 * 方案：提供一份**覆盖被测代码所用到的全部 electron 导出与子 API** 的完整 mock，
 * 让所有相关测试文件统一引用同一份常量。这样无论哪份 mock 最后注册，内容都一致
 * 且完整，彻底消除并发/串行互踩。
 *
 * 用法（在测试文件读取被测模块之前）：
 *   import { mock } from 'bun:test'
 *   import { buildElectronMock } from '../../testing/electron-mock'
 *   mock.module('electron', () => buildElectronMock())
 *   const { xxx } = await import('./被测模块')
 *
 * 说明：本 mock 只为「结构安全」——让被测代码在隔离的单元测试里不因 electron
 * 启动器二进制不可用而崩；不追求模拟 electron 的真实行为。所有方法返回安全默认值。
 */

/** 平台无关的当前主显示器快照 */
function primaryDisplay() {
  return {
    id: 'primary',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    workAreaSize: { width: 1920, height: 1080 },
    scaleFactor: 1,
  }
}

/** 最小 BrowserWindow 实例桩 */
class MockBrowserWindow {
  webContents = { send: () => {}, on: () => {}, off: () => {}, isDestroyed: () => false, isLoading: () => false, isCrashed: () => false, getURL: () => '', executeJavaScript: () => Promise.resolve(undefined) }
  clearCache = () => {}
  destroy = () => {}
  close = () => {}
  hide = () => {}
  show = () => {}
  focus = () => {}
  isDestroyed = () => false
  isVisible = () => false
  isFocused = () => false
  getBounds = () => ({ x: 0, y: 0, width: 1024, height: 768 })
  setBounds = () => {}
  setSize = () => {}
  loadURL = () => Promise.resolve(undefined)
  loadFile = () => Promise.resolve(undefined)
  on = () => this
  once = () => this
  static getAllWindows = () => []
  static getFocusedWindow = () => null
  static fromId = () => null
}

/** 最小 WebContentsView 桩（多标签容器用） */
class MockWebContentsView {
  setBounds = () => {}
  setBorderRadius = () => {}
}

/**
 * 构建一份完整的 Electron Mock。
 *
 * 覆盖被测源码所有命名导入 + 点访问（app / BrowserWindow / WebContentsView /
 * Menu / Tray / Notification / clipboard / dialog / globalShortcut / ipcMain /
 * nativeImage / nativeTheme / net / powerMonitor / protocol / safeStorage /
 * screen / session / shell / systemPreferences / desktopCapturer）。
 * 全部子 API 为安全默认，测试语义与原有各文件 mock 保持一致。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildElectronMock(): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyNativeImage = {} as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app: any = {
    isPackaged: false,
    getPath: () => '/tmp',
    getAppPath: () => '/tmp',
    whenReady: async () => undefined,
    on: () => app,
    once: () => app,
      isReady: () => false,
      quit: () => {},
      hide: () => {},
      show: () => {},
      setName: () => {},
      setBadgeCount: () => {},
      setAsDefaultProtocolClient: () => true,
      requestSingleInstanceLock: () => true,
      commandLine: { appendSwitch: () => {}, appendArgument: () => {} },
      dock: { setIcon: () => {}, show: () => {}, hide: () => {}, setBadge: () => {}, bounce: () => 0 },
      getVersion: () => 'test',
      getLocale: () => 'zh-CN',
      exit: () => {},
  }
  return {
    app,
    BrowserWindow: MockBrowserWindow,
    WebContentsView: MockWebContentsView,
    Menu: { build: () => ({ popup: () => {}, append: () => {} }), setApplicationMenu: () => {}, getApplicationMenu: () => null },
    Tray: class {
      setToolTip = () => {}
      setContextMenu = () => {}
      setTitle = () => {}
      on = () => this
      destroy = () => {}
    },
    Notification: class {
      show = () => {}
      close = () => {}
      on = () => this
      static isSupported = () => false
    },
    clipboard: {
      readText: () => '',
      writeText: () => {},
      readBuffer: () => Buffer.alloc(0),
      writeBuffer: () => {},
      readImage: () => anyNativeImage,
      writeImage: () => {},
      readHTML: () => '',
      readRTF: () => '',
      read: () => '',
      clear: () => {},
      availableFormats: () => [],
      write: () => {},
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: '' }),
      showMessageBox: async () => ({ response: 0 }),
      showErrorBox: () => {},
    },
    globalShortcut: { register: () => true, unregister: () => {}, unregisterAll: () => {} },
    ipcMain: { handle: () => {}, on: () => {}, once: () => {}, removeHandler: () => {}, removeAllListeners: () => {}, emit: () => {}, off: () => {} },
    nativeImage: {
      createFromBuffer: () => anyNativeImage,
      createFromPath: () => anyNativeImage,
      createEmpty: () => anyNativeImage,
    },
    nativeTheme: { on: () => {}, off: () => {}, shouldUseDarkColors: false, themeSource: 'system' },
    net: { request: () => ({ on: () => {}, pipe: () => {}, abort: () => {} }) },
    powerMonitor: { on: () => {}, off: () => {}, getSystemIdleState: () => 'unknown' },
    protocol: { registerFileProtocol: () => {}, interceptRequest: () => {}, handle: () => {} },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
      getSelectedStorageBackend: () => 'basic_text',
    },
    screen: {
      getPrimaryDisplay: primaryDisplay,
      getAllDisplays: () => [primaryDisplay()],
      getDisplayMatching: primaryDisplay,
      getDisplayNearestPoint: primaryDisplay,
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      on: () => {},
      off: () => {},
    },
    session: {
      fromPartition: () => ({
        setProxy: async () => {},
        clearCache: async () => {},
        cookies: { get: async () => [], set: async () => {}, remove: async () => {} },
        webRequest: { onBeforeRequest: () => {} },
        setPermissionRequestHandler: () => {},
        clearStorageData: async () => {},
        on: () => {},
      }),
      fromPath: () => ({}),
      defaultSession: {},
    },
    shell: { openExternal: () => Promise.resolve(), openPath: () => Promise.resolve(''), showItemInFolder: () => {}, trashItem: async () => {} },
    systemPreferences: { getAccentColor: () => '', isDarkMode: () => false, on: () => {}, subscribeNotification: () => 0, unsubscribeNotification: () => {} },
    desktopCapturer: { getSources: async () => [] },
    // 避免被测代码 `import * as electron` 枚举命名空间时额外需要缺省导出
    default: {},
  }
}

/** 便捷默认实例：测试文件可直接 `mock.module('electron', () => electronMock)` */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const electronMock: Record<string, unknown> = buildElectronMock()
