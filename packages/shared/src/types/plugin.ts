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
  | 'agent-tools'      // 向 Agent 注入工具（如 Computer Use 工具族）

/** 插件订阅的事件类型（基于 P0-2 AppEventEnvelope 五态） */
export type PluginSubscription =
  | 'app.started'
  | 'app.progress'
  | 'app.waiting_action'
  | 'app.completed'
  | 'app.failed'

/**
 * Computer Use 分档权限声明。
 *
 * 该字段是「插件所需/所用的 Computer Use 能力级别上限」，具体运行时启用
 * 级别由宿主配置（settings）控制，二者互不覆盖：manifest 声明上限，宿主门控决定实际放行。
 */
export interface ComputerUsePluginPermissions {
  /** 是否启用 Computer Use（总开关） */
  enabled?: boolean
  /** 仅只读子集：Status / Capabilities / FrontmostApplication / FrontmostWindow / Displays */
  readOnly?: boolean
  /** 是否允许写操作：Screenshot / Click / Type / Scroll / Drag / KeyCombo / RequestTakeover */
  allowWrite?: boolean
}

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
  /**
   * Computer Use 分档权限（声明上限）。
   * 未声明此字段（undefined）视为默认禁止（与历史约定一致）。
   */
  computerUse?: ComputerUsePluginPermissions
  // 默认禁止（不可在此声明即获得，需宿主显式门控）：文件系统、Shell、任意 IPC、渠道凭据、麦克风、主进程原生模块
}

/** 插件 Manifest */
export interface PluginManifest {
  schemaVersion: 1
  /** 反向域名 ID（如 com.gravitas.dynamic-island） */
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

/** 第一方内置插件清单（当前含灵动岛、Computer Use） */
export const BUILTIN_PLUGINS: Array<{ id: string; name: string; version: string }> = [
  { id: 'com.gravitas.dynamic-island', name: '灵动岛通知', version: '1.0.0' },
  { id: 'com.gravitas.computer-use', name: 'Computer Use', version: '1.0.0' },
  { id: 'com.gravitas.marketing', name: '营销应用中心', version: '0.1.0' },
]

/** 插件管理 IPC 通道 */
export const PLUGIN_IPC_CHANNELS = {
  /** 列出所有插件状态 */
  LIST: 'plugin:list',
  /** 启用/停用插件（id, enabled） */
  SET_ENABLED: 'plugin:set-enabled',
  /** 导入第三方插件（PH2-F：按 manifest 注册） */
  IMPORT: 'plugin:import',
  /** 删除/卸载第三方插件（仅 local；内置不可删） */
  DELETE: 'plugin:delete',
} as const
