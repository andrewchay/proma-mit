/**
 * Agent 权限服务
 *
 * 核心职责：
 * - 实现 canUseTool 回调（供 SDK query 使用）
 * - 管理 pending 权限请求（Promise + Map 模式）
 * - 维护会话级白名单
 * - 工具/命令分类判断
 *
 * 参考 Craft Agents OSS 的 Promise + Map 异步等待模式。
 */

import { randomUUID } from 'node:crypto'
import type {
  PromaPermissionMode,
  PermissionRequest,
  DangerLevel,
  AskUserRequest,
} from '@gravitas/shared'
import {
  SAFE_TOOLS,
  isSafeBashCommand,
  isDangerousCommand,
  hasDangerousStructure,
} from '@gravitas/shared'
import { getSettings, updateSettings } from './settings-service'
import {
  DEFAULT_AGENT_ALLOWLIST,
  type AgentAllowlist,
} from '../../types'

/**
 * 持久化 Allowlist 存储抽象。
 *
 * 默认实现是内存态（进程内跨会话、重启后失效），供单测与隔离实例使用，
 * 避免单测写入真实配置文件；生产单例注入 settings.json 后端，真正跨应用重启。
 */
export interface PersistentAllowlistStore {
  read(): AgentAllowlist
  update(fn: (current: AgentAllowlist) => AgentAllowlist): void
}

/**
 * 默认内存存储：进程内共享一份可变副本，跨会话生效但不落盘。
 * 单测与显式构造的隔离实例默认使用它，确保不触碰 ~/.proma/settings.json。
 */
function createMemoryAllowlistStore(): PersistentAllowlistStore {
  let value = { ...DEFAULT_AGENT_ALLOWLIST }
  return {
    read: () => ({ ...value }),
    update: (fn) => {
      value = fn({ ...value })
    },
  }
}

/**
 * settings.json 后端存储：真正跨应用重启持久化。
 * 由单例（生产路径）注入；不写入本次会话的高危操作。
 */
function createSettingsAllowlistStore(): PersistentAllowlistStore {
  return {
    read: () => {
      const allowlist = getSettings().agentAllowlist
      if (!allowlist) return { ...DEFAULT_AGENT_ALLOWLIST }
      return {
        allowedTools: Array.isArray(allowlist.allowedTools) ? [...allowlist.allowedTools] : [],
        allowedBashCommands: Array.isArray(allowlist.allowedBashCommands)
          ? [...allowlist.allowedBashCommands]
          : [],
        trustedWebBridgeHosts: Array.isArray(allowlist.trustedWebBridgeHosts)
          ? [...allowlist.trustedWebBridgeHosts]
          : [],
      }
    },
    update: (fn) => {
      const current = getSettings().agentAllowlist
      const next = fn(current && current.allowedTools
        ? current
        : { ...DEFAULT_AGENT_ALLOWLIST })
      // 归一化：数组默认空，去重，排序保证稳定 diff
      const normalized: AgentAllowlist = {
        allowedTools: dedupe(next.allowedTools),
        allowedBashCommands: dedupe(next.allowedBashCommands),
        trustedWebBridgeHosts: dedupe(next.trustedWebBridgeHosts),
      }
      updateSettings({ agentAllowlist: normalized })
    },
  }
}

/** 去重并排序（保持稳定、可比较） */
function dedupe(items: string[] | undefined): string[] {
  return [...new Set((items ?? []).filter((x) => typeof x === 'string' && x.length > 0))].sort()
}

/** SDK PermissionBehavior */
type PermissionBehavior = 'allow' | 'deny'

/** SDK PermissionUpdateDestination */
type PermissionUpdateDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'

/** SDK 权限规则值 */
interface PermissionRuleValue {
  toolName: string
  ruleContent?: string
}

/** SDK PermissionUpdate（匹配 SDK 0.2.63） */
export type PermissionUpdate = {
  type: 'addRules' | 'replaceRules' | 'removeRules'
  rules: PermissionRuleValue[]
  behavior: PermissionBehavior
  destination: PermissionUpdateDestination
} | {
  type: 'setMode'
  mode: string
  destination: PermissionUpdateDestination
} | {
  type: 'addDirectories' | 'removeDirectories'
  directories: string[]
  destination: PermissionUpdateDestination
}

/** SDK PermissionDecisionClassification（匹配 SDK 0.2.120） */
type PermissionDecisionClassification = 'user_temporary' | 'user_permanent' | 'user_reject'

/** SDK PermissionResult（匹配 SDK 0.2.120） */
export type PermissionResult = {
  behavior: 'allow'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: PermissionUpdate[]
  toolUseID?: string
  decisionClassification?: PermissionDecisionClassification
} | {
  behavior: 'deny'
  message: string
  interrupt?: boolean
  toolUseID?: string
  decisionClassification?: PermissionDecisionClassification
}

/** canUseTool 回调的 options 参数（匹配 SDK CanUseTool） */
export interface CanUseToolOptions {
  signal: AbortSignal
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  decisionReason?: string
  decisionReasonType?: string
  classifierApprovable?: boolean
  toolUseID: string
  agentID?: string
  title?: string
  displayName?: string
  description?: string
}

/** 待处理的权限请求 */
interface PendingPermission {
  resolve: (result: PermissionResult) => void
  request: PermissionRequest
}

/** 会话级白名单 */
interface SessionWhitelist {
  /** 总是允许的工具名（如 'Write', 'Edit'） */
  allowedTools: Set<string>
  /** 总是允许的 Bash 基础命令（如 'git push', 'npm install'） */
  allowedBashCommands: Set<string>
  /**
   * 受信任的 Web Bridge 站点域名（如 'example.com'）。
   * 用户对某站点的 WebBridge 操作点过「总是允许」后，该站点下的导航/点击/输入/下载
   * 在本会话内自动放行；WebBridgeUpload 永远逐次确认（涉及本地文件选择）。
   */
  trustedWebBridgeHosts: Set<string>
}

/**
 * Agent 权限服务
 *
 * 单例模式，管理所有会话的权限状态。
 */
export class AgentPermissionService {
  /** 待处理的权限请求 Map（requestId → PendingPermission） */
  private pendingPermissions = new Map<string, PendingPermission>()

  /** 持久化 Allowlist 存储（跨会话白名单）。未注入时默认内存态。 */
  private readonly persistentStore: PersistentAllowlistStore

  constructor(persistentStore?: PersistentAllowlistStore) {
    this.persistentStore = persistentStore ?? createMemoryAllowlistStore()
  }

  /** 会话级白名单 Map（sessionId → SessionWhitelist） */
  private sessionWhitelists = new Map<string, SessionWhitelist>()

  /** 会话当前 WebBridge 页面 host（sessionId → host），由 noteWebBridgeHost 维护 */
  private webBridgeCurrentHosts = new Map<string, string>()

  /**
   * 创建 canUseTool 回调（auto 模式及 escalation 场景使用）
   *
   * SDK 的 auto 模式内置 classifier 自动处理大多数权限决策，仅在 classifier 无法判断时
   * 才调用此回调（escalation）。返回的函数签名匹配 SDK 的 CanUseTool 类型。
   */
  createCanUseTool(
    sessionId: string,
    sendToRenderer: (request: PermissionRequest) => void,
    askUserHandler?: (sessionId: string, input: Record<string, unknown>, signal: AbortSignal, sendToRenderer: (request: AskUserRequest) => void) => Promise<PermissionResult>,
    sendAskUserToRenderer?: (request: AskUserRequest) => void,
    mode?: PromaPermissionMode | (() => PromaPermissionMode),
  ): (toolName: string, input: Record<string, unknown>, options: CanUseToolOptions) => Promise<PermissionResult> {
    return async (toolName, input, options) => {
      // AskUserQuestion 拦截：委托给交互式问答服务
      if (toolName === 'AskUserQuestion' && askUserHandler && sendAskUserToRenderer) {
        return askUserHandler(sessionId, input, options.signal, sendAskUserToRenderer)
      }

      const allow = (): PermissionResult => ({ behavior: 'allow' as const, updatedInput: input })

      // 系统级桌面读取/控制不能由子 Agent 自动批准，也不能沿用“始终允许”。
      // 这类操作可能读取任意屏幕内容或影响前台应用，必须回到用户确认流程。
      // Web Bridge 上传涉及本地文件选择/内容注入，永远逐次确认。
      // Web Bridge 下载：若当前站点已被信任（用户对该域名点过“总是允许”），则自动放行；
      // 否则仍逐次确认。导航/点击/输入等页面交互沿用“加工具白名单”机制（可一次放行）…
      const computerUse = isComputerUseTool(toolName)
      const webBridgeUploadOnly = toolName === WEB_BRIDGE_UPLOAD_TOOL_NAME
      const webBridgeDownloadTrusted = toolName === WEB_BRIDGE_DOWNLOAD_TOOL_NAME && this.isWebBridgeSiteTrusted(sessionId)
      const requiresPerActionApproval = computerUse || webBridgeUploadOnly || (toolName === WEB_BRIDGE_DOWNLOAD_TOOL_NAME && !webBridgeDownloadTrusted)

      // Worker（子代理）的工具调用自动批准，避免 UI 等待导致超时死锁
      // （Computer Use 与 Web Bridge 上传仍需逐次确认；下载在站点未信任时需确认）
      if (options.agentID && !requiresPerActionApproval) {
        return allow()
      }
      // 站点已信任的下载直接放行
      if (webBridgeDownloadTrusted) return allow()

      const currentMode = typeof mode === 'function' ? mode() : mode

      // safe 模式：非只读操作直接拒绝，不向用户弹审批，也不沿用历史白名单
      if (currentMode === 'safe' && !this.isReadOnlyTool(toolName, input)) {
        return { behavior: 'deny', message: '安全模式下不允许执行写操作，请切换到自动审批或完全自动模式' }
      }

      // 会话白名单检查（用户之前选择了"始终允许"）
      if (!requiresPerActionApproval && this.isWhitelisted(sessionId, toolName, input)) return allow()

      // auto 模式本地 classifier：只读工具（Read/Glob/Grep/WebSearch/WebFetch 及只读 Bash 命令）自动放行
      // 原因：CLI 的 --permission-prompt-tool stdio 会把每次 tool 调用都转发给 canUseTool，
      // SDK 的 auto classifier 对只读操作未必真的放行，这里做本地兜底避免用户被无意义的审批打扰
      if (this.isReadOnlyTool(toolName, input)) return allow()

      // auto 模式下 SDK classifier 已判定安全的操作（classifierApprovable）自动放行
      // 例如常规文件写入、常见构建命令等。仅在高风险场景（危险等级 dangerous）仍回退人工确认。
      if (
        currentMode === 'auto' &&
        options.classifierApprovable === true &&
        this.assessDangerLevel(toolName, input) !== 'dangerous'
      ) {
        return allow()
      }

      // auto 模式下常规文件写入（Write/Edit/NotebookEdit 到工作区内的常规路径）自动放行，
      // 避免每个文件改动都弹窗。危险路径（系统目录、隐藏敏感文件）仍走人工确认。
      if (
        currentMode === 'auto' &&
        ['Write', 'Edit', 'NotebookEdit'].includes(toolName) &&
        this.isRegularProjectPath(input)
      ) {
        return allow()
      }

      // 需要询问用户：构建请求并发送到 UI
      const request = this.buildPermissionRequest(sessionId, toolName, input, options)
      sendToRenderer(request)

      return new Promise<PermissionResult>((resolve) => {
        this.pendingPermissions.set(request.requestId, { resolve, request })

        // 如果 signal 被中止，自动拒绝
        options.signal.addEventListener('abort', () => {
          if (this.pendingPermissions.has(request.requestId)) {
            this.pendingPermissions.delete(request.requestId)
            resolve({ behavior: 'deny' as const, message: '操作已中止' })
          }
        }, { once: true })
      })
    }
  }

  /**
   * 响应权限请求（由 IPC handler 调用）
   *
   * @returns 对应的 sessionId，用于向渲染进程发送 resolved 事件；未找到请求时返回 null
   */
  respondToPermission(requestId: string, behavior: 'allow' | 'deny', alwaysAllow: boolean): string | null {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return null

    const sessionId = pending.request.sessionId

    // "总是允许"选项：
    // - Web Bridge 上传除外（仍逐次确认）；其余 WebBridge 工具把「当前站点域名」加入信任
    //   集合，而不是把整个工具加白名单——这样下载/点击等在可信站点下自动放行。
    // - Computer Use 始终逐次确认，不加入白名单。
    if (alwaysAllow && behavior === 'allow') {
      if (!isComputerUseTool(pending.request.toolName) && !isWebBridgeFileTransfer(pending.request.toolName)) {
        this.addToWhitelist(sessionId, pending.request.toolName, pending.request.toolInput)
        // 同步持久化：用户主动"始终允许"的工具/命令族跨会话沿用。
        // 危险命令（rm/sudo 等）不会进入（isWhitelisted 命中前仍经 isDangerousCommand 拦截）。
        this.persistAllow(pending.request.toolName, pending.request.toolInput)
      } else if (isWebBridgeFileTransfer(pending.request.toolName) && pending.request.toolName !== WEB_BRIDGE_UPLOAD_TOOL_NAME) {
        // WebBridgeDownload：用户点“总是允许”= 信任当前站点域名
        this.trustCurrentWebBridgeHost(sessionId)
      }
    }

    pending.resolve(
      behavior === 'allow'
        ? { behavior: 'allow' as const, updatedInput: pending.request.toolInput }
        : { behavior: 'deny' as const, message: '用户拒绝了此操作' }
    )
    this.pendingPermissions.delete(requestId)
    return sessionId
  }

  /**
   * 清除指定会话的所有待处理请求（会话结束或中止时调用）
   */
  clearSessionPending(sessionId: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.request.sessionId === sessionId) {
        pending.resolve({ behavior: 'deny' as const, message: '会话已结束' })
        this.pendingPermissions.delete(requestId)
      }
    }
  }

  /**
   * 获取当前所有待处理的权限请求（用于渲染进程重载后恢复状态）
   */
  getPendingRequests(): PermissionRequest[] {
    return [...this.pendingPermissions.values()].map((p) => p.request)
  }

  /**
   * 清除指定会话的白名单（会话结束时调用）
   */
  clearSessionWhitelist(sessionId: string): void {
    this.sessionWhitelists.delete(sessionId)
    this.webBridgeCurrentHosts.delete(sessionId)
  }

  // ===== 工具分类判断 =====

  /**
   * 判断工具是否为只读操作（智能模式下自动允许）
   */
  private isReadOnlyTool(toolName: string, input: Record<string, unknown>): boolean {
    // 安全工具白名单
    if (SAFE_TOOLS.includes(toolName)) return true

    // Bash 工具：检查命令是否匹配安全模式
    if (toolName === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : ''
      return isSafeBashCommand(command)
    }

    return false
  }

  /**
   * 判断文件写入路径是否属于"常规项目路径"（auto 模式下自动放行）
   *
   * 放行条件：
   * - 非隐藏敏感文件（.env、.ssh、密钥文件等）
   * - 非系统关键目录（/etc、/usr、/Library、/Applications 等）
   * - 非根目录/家目录根
   * 返回 true 时允许 Write/Edit/NotebookEdit 自动放行。
   */
  private isRegularProjectPath(input: Record<string, unknown>): boolean {
    const filePath = (
      typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.notebook_path === 'string'
          ? input.notebook_path
          : typeof input.path === 'string'
            ? input.path
            : ''
    ).trim()

    if (!filePath) return false

    // 敏感文件名/路径片段（.env、凭据、密钥、配置令牌）
    const SENSITIVE_PATTERNS = [
      /\.env(?:\.[a-zA-Z0-9]+)?$/,       // .env / .env.local
      /\.ssh\//,                          // SSH 私钥目录
      /\.aws\//,                          // AWS 凭据
      /\.git-credentials$/,               // Git 凭据
      /\.npmrc$/,                         // npm 配置（可能含 token）
      /\.pypirc$/,                        // pip 凭据
      /\.netrc$/,                         // 通用凭据
      /\.zshrc$|\.bashrc$|\.bash_profile$/, // shell 配置
      /\.pem$|\.key$|\.crt$/,           // 证书/私钥
      /\.kube\//,                         // Kubernetes 配置
      /\.gradle\//,                       // Gradle 凭据
      /\.m2\//,                           // Maven 凭据
      /\.docker\//,                       // Docker 配置
      /\.npm\//,                          // npm 缓存
    ]
    if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(filePath))) return false

    // 系统关键目录（不允许自动放行写入）
    const SYSTEM_PATH_PREFIXES = [
      '/etc/',
      '/usr/',
      '/bin/',
      '/sbin/',
      '/var/',
      '/Library/',
      '/Applications/',
      '/System/',
      '/private/',
      '/opt/',
      '/root/',
      '/dev/',
      '/proc/',
    ]
    if (SYSTEM_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix))) return false

    // 家目录根的直接配置文件（~/ 下不带子目录的隐藏文件，如 ~/.gitconfig）
    const home = process.env.HOME || ''
    if (home && filePath.startsWith(home)) {
      const rel = filePath.slice(home.length).replace(/^\/+/, '')
      // 只放行家目录下项目子目录中的写入；家目录根的直接文件仍需确认
      if (!rel.includes('/') || rel.startsWith('.')) return false
    }

    return true
  }

  /**
   * 判断工具/命令是否在白名单中：会话级或跨会话持久化级别命中即放行。
   * 危险命令在任何一级都不会因命令族命中而放行。
   */
  private isWhitelisted(sessionId: string, toolName: string, input: Record<string, unknown>): boolean {
    const whitelist = this.sessionWhitelists.get(sessionId)
    const persistent = this.persistentStore.read()

    // 非 Bash 工具：工具名在任一级白名单即放行
    if (toolName !== 'Bash') {
      if (whitelist?.allowedTools.has(toolName)) return true
      return persistent.allowedTools.includes(toolName)
    }

    // Bash 工具：命令族在任一级白名单中即可放行（用户已明确信任该命令族）
    //
    // 安全性说明：
    // - isDangerousCommand 仍拦截 rm / sudo / chmod / mv / curl 等危险命令，
    //   即使命令族被"总是允许"也不会自动执行。
    // - 不再因管道/重定向/&& 等结构拒绝：用户常用 `bun run dev && echo ok`、
    //   `git log | head` 等组合，若因结构拒绝会破坏"总是允许"的承诺。
    //   危险结构由 isDangerousCommand 覆盖到的子命令（rm -rf | ... 等）兜底。
    const command = typeof input.command === 'string' ? input.command : ''
    if (isDangerousCommand(command)) return false
    const baseCommand = this.extractBaseCommand(command)
    if (!baseCommand) return false
    if (whitelist?.allowedBashCommands.has(baseCommand)) return true
    return persistent.allowedBashCommands.includes(baseCommand)
  }

  /**
   * 把用户主动「始终允许」的工具/命令族写入跨会话持久化 Allowlist。
   *
   * 安全边界与 addToWhitelist 一致：
   * - 危险 Bash 命令绝不入库（由 isDangerousCommand 拦截），
   *   即使用户误选也只生效于本次会话且不持久化；
   * - Computer Use / Web Bridge 上传/下载由调用方先行拦截，不会走到这里。
   */
  private persistAllow(toolName: string, input: Record<string, unknown>): void {
    this.persistentStore.update((current) => {
      if (toolName !== 'Bash') {
        if (current.allowedTools.includes(toolName)) return current
        return {
          ...current,
          allowedTools: [...current.allowedTools, toolName],
        }
      }
      const command = typeof input.command === 'string' ? input.command : ''
      // 危险命令绝不持久化：白名单只能收容经过校验的安全命令族
      if (isDangerousCommand(command)) return current
      const baseCommand = this.extractBaseCommand(command)
      if (!baseCommand || current.allowedBashCommands.includes(baseCommand)) return current
      return {
        ...current,
        allowedBashCommands: [...current.allowedBashCommands, baseCommand],
      }
    })
  }

  /**
   * 移除一条跨会话持久化 Allowlist 记录（工具名或命令族）。
   * 用于设置页的"移除始终允许项"。
   */
  removePersistentAllow(entry: string): void {
    this.persistentStore.update((current) => ({
      allowedTools: current.allowedTools.filter((t) => t !== entry),
      allowedBashCommands: current.allowedBashCommands.filter((c) => c !== entry),
      trustedWebBridgeHosts: current.trustedWebBridgeHosts,
    }))
  }

  /** 读取当前跨会话持久化 Allowlist（用于设置页展示与审计）。 */
  getPersistentAllowlist(): AgentAllowlist {
    return this.persistentStore.read()
  }

  /**
   * 将工具/命令加入会话白名单
   */
  private addToWhitelist(sessionId: string, toolName: string, input: Record<string, unknown>): void {
    const whitelist = this.getOrCreateWhitelist(sessionId)

    if (toolName !== 'Bash') {
      whitelist.allowedTools.add(toolName)
    } else {
      const command = typeof input.command === 'string' ? input.command : ''
      const baseCommand = this.extractBaseCommand(command)
      if (baseCommand) {
        whitelist.allowedBashCommands.add(baseCommand)
      }
    }
  }

  /**
   * 获取或创建会话白名单
   */
  private getOrCreateWhitelist(sessionId: string): SessionWhitelist {
    const existing = this.sessionWhitelists.get(sessionId)
    if (existing) return existing

    const whitelist: SessionWhitelist = {
      allowedTools: new Set(),
      allowedBashCommands: new Set(),
      trustedWebBridgeHosts: new Set(),
    }
    this.sessionWhitelists.set(sessionId, whitelist)
    return whitelist
  }

  /**
   * 记录某会话当前 WebBridge 页面的 host（供站点信任判断与展示用，不改变信任状态）。
   * 由 web-bridge-service 在导航成功后调用。
   */
  noteWebBridgeHost(sessionId: string, url: string): void {
    const host = extractUrlHost(url)
    if (!host) return
    this.getOrCreateWhitelist(sessionId)
    this.webBridgeCurrentHosts.set(sessionId, host)
  }

  /**
   * 把某会话的站点域名加入信任集合。用户对 WebBridge 操作点「总是允许」时调用。
   * 同步写入跨会话持久化 Allowlist，后续会话对同域名自动放行。
   */
  trustWebBridgeHost(sessionId: string, url: string): void {
    const host = extractUrlHost(url)
    if (!host) return
    this.getOrCreateWhitelist(sessionId).trustedWebBridgeHosts.add(host)
    this.persistTrustedWebBridgeHost(host)
  }

  /** 信任当前会话 WebBridge 页面的 host（无则忽略），并跨会话持久化。 */
  trustCurrentWebBridgeHost(sessionId: string): void {
    const host = this.webBridgeCurrentHosts.get(sessionId)
    if (!host) return
    this.getOrCreateWhitelist(sessionId).trustedWebBridgeHosts.add(host)
    this.persistTrustedWebBridgeHost(host)
  }

  /** 把站点域名写入跨会话持久化 WebBridge 信任集（去重）。 */
  private persistTrustedWebBridgeHost(host: string): void {
    this.persistentStore.update((current) => {
      if (current.trustedWebBridgeHosts.includes(host)) return current
      return {
        ...current,
        trustedWebBridgeHosts: [...current.trustedWebBridgeHosts, host],
      }
    })
  }

  /** 判断某会话当前 WebBridge 站点的域名是否已被用户信任（会话级或跨会话级）。 */
  isWebBridgeSiteTrusted(sessionId: string): boolean {
    const currentHost = this.webBridgeCurrentHosts.get(sessionId)
    if (!currentHost) return false
    if (this.sessionWhitelists.get(sessionId)?.trustedWebBridgeHosts.has(currentHost)) return true
    return this.persistentStore.read().trustedWebBridgeHosts.includes(currentHost)
  }

  /**
   * 提取 Bash 命令的基础命令（用于白名单匹配）
   *
   * 只提取第一个词作为命令族（如 "bun"、"git"、"npm"、"ls"、"cat"）。
   * 用户选择了"本次会话总是允许"后，同一命令族的不同子命令（如
   * "bun install" / "bun run dev" / "bun add"）都应自动放行，
   * 而不是要求每个具体子命令都单独确认一次，避免频繁弹窗打扰。
   *
   * 安全性由调用方（isWhitelisted）通过 isDangerousCommand /
   * hasDangerousStructure 独立保障：危险命令/危险结构永远无法仅靠
   * 命令族命中白名单而放行。
   */
  private extractBaseCommand(command: string): string {
    const parts = command.trim().split(/\s+/)
    return parts[0] ?? ''
  }

  /**
   * 构建权限请求对象
   */
  private buildPermissionRequest(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ): PermissionRequest {
    const command = toolName === 'Bash' && typeof input.command === 'string'
      ? input.command
      : undefined

    return {
      requestId: randomUUID(),
      sessionId,
      toolName,
      toolInput: input,
      description: this.buildDescription(toolName, input),
      command,
      dangerLevel: this.assessDangerLevel(toolName, input),
      decisionReason: options.decisionReason,
      decisionReasonType: options.decisionReasonType,
      classifierApprovable: options.classifierApprovable,
      sdkDisplayName: options.displayName,
      sdkTitle: options.title,
      sdkDescription: options.description,
    }
  }

  /**
   * 生成人类可读的操作描述
   */
  private buildDescription(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'Bash':
        return typeof input.command === 'string'
          ? `执行命令: ${input.command.slice(0, 200)}`
          : '执行 Bash 命令'
      case 'Write':
        return typeof input.file_path === 'string'
          ? `写入文件: ${input.file_path}`
          : '写入文件'
      case 'Edit':
        return typeof input.file_path === 'string'
          ? `编辑文件: ${input.file_path}`
          : '编辑文件'
      case 'NotebookEdit':
        return typeof input.notebook_path === 'string'
          ? `编辑 Notebook: ${input.notebook_path}`
          : '编辑 Notebook'
      case 'Task':
        return typeof input.description === 'string'
          ? `启动子任务: ${input.description}`
          : '启动子任务'
      default:
        return `使用工具: ${toolName}`
    }
  }

  /**
   * 评估操作的危险等级
   */
  private assessDangerLevel(toolName: string, input: Record<string, unknown>): DangerLevel {
    if (toolName === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : ''
      if (isDangerousCommand(command)) return 'dangerous'
      if (hasDangerousStructure(command)) return 'normal'
      return 'normal'
    }

    // 文件写入操作默认为 normal
    if (['Write', 'Edit', 'NotebookEdit'].includes(toolName)) return 'normal'

    // Task 工具默认为 normal
    if (toolName === 'Task') return 'normal'

    return 'normal'
  }

  /**
   * PH2-③：是否高危工具——无人值守(bypassPermissions)下仍需克制/回退的操作。
   * 高危 Bash 命令、Computer Use、Web Bridge 上传/下载。这类操作不自动放行。
   */
  isHighRiskTool(toolName: string, input: Record<string, unknown>): boolean {
    if (this.assessDangerLevel(toolName, input) === 'dangerous') return true
    if (isComputerUseTool(toolName)) return true
    if (isWebBridgeFileTransfer(toolName)) return true
    return false
  }
}

function isComputerUseTool(toolName: string): boolean {
  return toolName.startsWith('ComputerUse') && toolName !== 'ComputerUseStatus'
}

/** Web Bridge 上传工具名（本地文件选择/内容注入，永远逐次确认）。 */
const WEB_BRIDGE_UPLOAD_TOOL_NAME = 'WebBridgeUpload'

/** Web Bridge 下载工具名（站点信任后自动放行）。 */
const WEB_BRIDGE_DOWNLOAD_TOOL_NAME = 'WebBridgeDownload'

/**
 * Web Bridge 下载/上传涉及本地文件系统（读取用户文件、写入磁盘），
 * 需逐次确认，不能仅靠工具名白名单放行。
 */
function isWebBridgeFileTransfer(toolName: string): boolean {
  return new Set([
    'WebBridgeDownload',
    'WebBridgeUpload',
  ]).has(toolName)
}

/** 从 URL 提取 host（用于站点信任粒度）。无 host 返回 undefined。 */
function extractUrlHost(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined
  try {
    return new URL(rawUrl).hostname.toLowerCase() || undefined
  } catch {
    return undefined
  }
}

/** 全局权限服务实例（持久化白名单使用 settings.json 后端，跨应用重启生效） */
export const permissionService = new AgentPermissionService(createSettingsAllowlistStore())
