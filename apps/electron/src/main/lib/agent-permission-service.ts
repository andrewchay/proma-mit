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
} from '@proma/shared'
import {
  SAFE_TOOLS,
  isSafeBashCommand,
  isDangerousCommand,
  hasDangerousStructure,
} from '@proma/shared'

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
}

/**
 * Agent 权限服务
 *
 * 单例模式，管理所有会话的权限状态。
 */
export class AgentPermissionService {
  /** 待处理的权限请求 Map（requestId → PendingPermission） */
  private pendingPermissions = new Map<string, PendingPermission>()

  /** 会话级白名单 Map（sessionId → SessionWhitelist） */
  private sessionWhitelists = new Map<string, SessionWhitelist>()

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
      // Web Bridge 下载/上传涉及本地文件系统，同样保持逐次确认；
      // 导航/点击/输入等页面交互允许通过会话白名单免确认（对齐 kimi-cli 的 approve_for_session）。
      const requiresPerActionApproval = isComputerUseTool(toolName) || isWebBridgeFileTransfer(toolName)

      // Worker（子代理）的工具调用自动批准，避免 UI 等待导致超时死锁
      if (options.agentID && !requiresPerActionApproval) {
        return allow()
      }

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

    // "总是允许"选项：加入会话白名单（Computer Use 与 Web Bridge 下载/上传除外，仍逐次确认）
    if (alwaysAllow && behavior === 'allow' && !isComputerUseTool(pending.request.toolName) && !isWebBridgeFileTransfer(pending.request.toolName)) {
      this.addToWhitelist(sessionId, pending.request.toolName, pending.request.toolInput)
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
   * 判断工具/命令是否在会话白名单中
   */
  private isWhitelisted(sessionId: string, toolName: string, input: Record<string, unknown>): boolean {
    const whitelist = this.sessionWhitelists.get(sessionId)
    if (!whitelist) return false

    // 非 Bash 工具：检查工具名是否在白名单中
    if (toolName !== 'Bash') {
      return whitelist.allowedTools.has(toolName)
    }

    // Bash 工具：即使基础命令在白名单中，也要重新检查完整命令的安全性
    const command = typeof input.command === 'string' ? input.command : ''
    if (hasDangerousStructure(command)) return false
    if (isDangerousCommand(command)) return false
    const baseCommand = this.extractBaseCommand(command)
    return whitelist.allowedBashCommands.has(baseCommand)
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
    }
    this.sessionWhitelists.set(sessionId, whitelist)
    return whitelist
  }

  /**
   * 提取 Bash 命令的基础命令（用于白名单匹配）
   *
   * 提取前两个词（如 "git push"、"npm install"）或第一个词（如 "ls"）。
   */
  private extractBaseCommand(command: string): string {
    const parts = command.trim().split(/\s+/)
    // 两词组合命令（git push, npm install 等）
    if (parts.length >= 2 && ['git', 'npm', 'bun', 'yarn', 'pnpm'].includes(parts[0]!)) {
      return `${parts[0]} ${parts[1]}`
    }
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
}

function isComputerUseTool(toolName: string): boolean {
  return toolName.startsWith('ComputerUse') && toolName !== 'ComputerUseStatus'
}

/**
 * Web Bridge 下载/上传涉及本地文件系统（读取用户文件、写入磁盘），
 * 必须逐次确认，不能加入会话白名单。
 * 导航/点击/输入等页面交互不在此列，允许用户选择"本次会话总是允许"。
 */
function isWebBridgeFileTransfer(toolName: string): boolean {
  return new Set([
    'WebBridgeDownload',
    'WebBridgeUpload',
  ]).has(toolName)
}

/** 全局权限服务实例 */
export const permissionService = new AgentPermissionService()
