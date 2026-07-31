/**
 * PluginManifest — 扩展（Extension）Manifest 与生命周期类型（P1-1 骨架）。
 *
 * 第一版只定义类型契约，不实现运行时加载。以 macOS 灵动岛为第一方样板：
 * - manifest 声明：id/版本/平台/surfaces/权限/订阅事件
 * - 权限模型：声明式细分权限，默认禁文件系统/Shell/凭据/主进程原生模块
 * - 生命周期状态：discover → installed → enabled → disabled → uninstalled
 *
 * 设计原则：
 * - 第三方插件不能注入 Electron 主进程或复用完整 electronAPI
 * - 原生能力由 Proma 签名的平台 adapter / 独立 helper 代理
 * - 权限增加必须重新确认，补丁升级不得静默扩大权限
 */

/** 插件支持的平台 */
export type PluginPlatform = 'darwin' | 'win32' | 'linux'

/** 插件生命周期状态 */
export type PluginLifecycleState =
  | 'discovered'       // 发现但未安装
  | 'installed'        // 已安装，默认 disabled（权限待审）
  | 'enabled'          // 已启用
  | 'disabled'         // 已停用
  | 'error'            // 运行异常（崩溃/权限不符）
  | 'uninstalled'      // 已卸载

/** 插件可贡献的 surface 类型 */
export type PluginSurfaceType =
  | 'overlay'          // 系统浮层（如灵动岛）
  | 'notification'     // 通知
  | 'menu-bar'         // 菜单栏
  | 'settings'         // 设置页区块
  | 'preview'          // 文件预览渲染器
  | 'workflow-node'    // Workflow 节点
  | 'bridge-connector' // 外部平台连接

/** 插件订阅的事件类型（基于 P0-2 AppEventEnvelope 五态） */
export type PluginSubscription =
  | 'app.started'
  | 'app.progress'
  | 'app.waiting_action'
  | 'app.completed'
  | 'app.failed'

/** 声明式权限（细分到最小粒度） */
export interface PluginPermissions {
  /** 读取 Agent/Workflow 摘要事件 */
  events?: boolean
  /** 读取敏感正文（完整消息/文件路径） */
  sensitiveContent?: boolean
  /** 创建 Overlay 或系统通知 */
  overlay?: boolean
  /** 打开会话 */
  openSession?: boolean
  /** 受限网络域名白名单 */
  networkDomains?: string[]
  /** 插件私有存储 */
  storage?: boolean
  /** 全局快捷键 */
  globalShortcut?: boolean
  // 默认禁止：文件系统、Shell、任意 IPC、渠道凭据、麦克风、Computer Use、主进程原生模块
}

/** 插件 Manifest */
export interface PluginManifest {
  schemaVersion: 1
  /** 反向域名 ID（如 com.proma.dynamic-island） */
  id: string
  /** semver 版本 */
  version: string
  /** 展示名 */
  name: string
  description?: string
  publisher: string
  /** 最低宿主版本 */
  minHostVersion?: string
  /** 支持平台 */
  platforms: PluginPlatform[]
  /** 启动时机 */
  activationEvents: Array<'onAppReady' | 'onFirstTask'>
  /** 订阅事件 */
  subscriptions: PluginSubscription[]
  /** 贡献的 surface */
  surfaces: PluginSurfaceType[]
  /** 权限声明 */
  permissions: PluginPermissions
  /** 入口点（运行时 + 可选 UI） */
  entrypoints: {
    /** 主进程运行时入口（受控加载） */
    runtime?: string
    /** surface UI 入口（独立 sandbox 加载） */
    renderer?: string
  }
}

/** 插件安装状态（运行时记录） */
export interface PluginInstallState {
  manifest: PluginManifest
  state: PluginLifecycleState
  /** 最近错误信息 */
  error?: string
  installedAt: number
  updatedAt: number
  /** 崩溃计数（连续崩溃自动隔离） */
  crashCount?: number
  /** 用户确认过的权限快照（升级时比对是否扩大） */
  approvedPermissions?: PluginPermissions
}

/** 插件安装/更新输入 */
export interface PluginInstallInput {
  /** manifest 内容 */
  manifest: PluginManifest
  /** 签名或内容 hash（第一方插件由宿主提供） */
  signature?: string
  hash?: string
  /** 安装包来源 */
  source: 'bundled' | 'marketplace' | 'local'
}

/** 第一方内置插件清单（当前仅灵动岛作为样板） */
export const BUILTIN_PLUGINS: Array<{ id: string; name: string; version: string }> = [
  { id: 'com.proma.dynamic-island', name: '灵动岛通知', version: '1.0.0' },
]
