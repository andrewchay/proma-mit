/**
 * 配置路径工具
 *
 * 管理 Proma MIT 应用的本地配置文件路径。
 * 所有用户配置存储在 ~/.proma-mit/ 目录下。
 */

import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { mkdirSync, existsSync, cpSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { APP_CONFIG_DIR_NAME } from './app-identity'

/**
 * 获取配置目录名称
 *
 * 统一返回 '.proma-mit'，不区分开发/正式版本。
 */
let _configDirName: string | undefined

export function getConfigDirName(): string {
  if (_configDirName === undefined) {
    // 统一使用 ~/.proma-mit/，不再区分开发/正式版本
    _configDirName = APP_CONFIG_DIR_NAME
    console.log(`[配置] 配置目录: ~/${_configDirName}/`)
  }
  return _configDirName
}

/**
 * 获取配置目录路径
 *
 * 统一返回 ~/.proma-mit/。
 * 如果目录不存在则自动创建。
 */
export function getConfigDir(): string {
  const overrideDir = process.env.PROMA_TEST_CONFIG_DIR?.trim()
  if (overrideDir) {
    if (!existsSync(overrideDir)) {
      mkdirSync(overrideDir, { recursive: true })
    }
    return overrideDir
  }

  const configDir = join(homedir(), getConfigDirName())

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
    console.log(`[配置] 已创建配置目录: ${configDir}`)
  }

  return configDir
}

/**
 * 获取渠道配置文件路径
 *
 * @returns ~/.proma/channels.json
 */
export function getChannelsPath(): string {
  return join(getConfigDir(), 'channels.json')
}

/**
 * 获取对话索引文件路径
 *
 * @returns ~/.proma/conversations.json
 */
export function getConversationsIndexPath(): string {
  return join(getConfigDir(), 'conversations.json')
}

/**
 * 获取对话消息目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.proma/conversations/
 */
export function getConversationsDir(): string {
  const dir = join(getConfigDir(), 'conversations')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建对话目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定对话的消息文件路径
 *
 * @param id 对话 ID
 * @returns ~/.proma/conversations/{id}.jsonl
 */
export function getConversationMessagesPath(id: string): string {
  return join(getConversationsDir(), `${id}.jsonl`)
}

/**
 * 获取 Token 使用统计目录路径
 *
 * @returns ~/.proma-mit/token-usage/
 */
export function getTokenUsageDir(): string {
  const dir = join(getConfigDir(), 'token-usage')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Token 统计目录: ${dir}`)
  }
  return dir
}

/**
 * 获取指定时间所在月份的 Token 使用统计文件路径
 *
 * @param ts 毫秒时间戳
 * @returns ~/.proma-mit/token-usage/{YYYY-MM}.jsonl
 */
export function getTokenUsageMonthPath(ts: number): string {
  const d = new Date(ts)
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  return join(getTokenUsageDir(), `${month}.jsonl`)
}

/**
 * 获取 Token 使用统计索引文件路径
 *
 * @returns ~/.proma-mit/token-usage/index.json
 */
export function getTokenUsageIndexPath(): string {
  return join(getTokenUsageDir(), 'index.json')
}

/**
 * 获取 Goal 状态目录路径
 *
 * @returns ~/.proma-mit/goals/
 */
export function getGoalsDir(): string {
  const dir = join(getConfigDir(), 'goals')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Goal 目录: ${dir}`)
  }
  return dir
}

/**
 * 获取单个 Goal 状态文件路径
 *
 * @returns ~/.proma-mit/goals/{goalId}.json
 */
export function getGoalPath(id: string): string {
  return join(getGoalsDir(), `${id}.json`)
}

/**
 * 获取 Goal 索引文件路径
 *
 * @returns ~/.proma-mit/goals/index.json
 */
export function getGoalIndexPath(): string {
  return join(getGoalsDir(), 'index.json')
}

/**
 * 获取附件存储根目录
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.proma/attachments/
 */
export function getAttachmentsDir(): string {
  const dir = join(getConfigDir(), 'attachments')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建附件目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定对话的附件目录
 *
 * 如果目录不存在则自动创建。
 *
 * @param conversationId 对话 ID
 * @returns ~/.proma/attachments/{conversationId}/
 */
export function getConversationAttachmentsDir(conversationId: string): string {
  if (!conversationId || basename(conversationId) !== conversationId || conversationId === '.' || conversationId === '..') {
    throw new Error('附件对话 ID 必须是单个安全路径段')
  }

  const dir = join(getAttachmentsDir(), conversationId)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 解析附件相对路径为完整路径
 *
 * @param localPath 相对路径 {conversationId}/{uuid}.ext
 * @returns 完整路径 ~/.proma/attachments/{conversationId}/{uuid}.ext
 */
export function resolveAttachmentPath(localPath: string): string {
  if (!localPath || isAbsolute(localPath)) {
    throw new Error('附件路径必须是非空相对路径')
  }

  return resolvePathWithinDirectory(getAttachmentsDir(), localPath, '附件路径')
}

/**
 * 解析目录内的相对路径，并拒绝路径穿越。
 */
export function resolvePathWithinDirectory(directory: string, localPath: string, label: string): string {
  if (isAbsolute(localPath)) {
    throw new Error(`${label}必须是相对路径`)
  }

  const root = resolve(directory)
  const target = resolve(root, localPath)
  const pathFromRoot = relative(root, target)
  if (!pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`${label}不在安全目录内`)
  }

  return target
}

/**
 * 验证绝对路径位于本机 Proma 配置目录内。
 */
export function resolveConfigPath(localPath: string): string {
  if (!isAbsolute(localPath)) {
    throw new Error('配置附件路径必须是绝对路径')
  }

  const configDir = resolve(getConfigDir())
  const target = resolve(localPath)
  const pathFromConfigDir = relative(configDir, target)
  if (!pathFromConfigDir || pathFromConfigDir === '..' || pathFromConfigDir.startsWith(`..${sep}`) || isAbsolute(pathFromConfigDir)) {
    throw new Error(`附件路径不在安全目录内: ${localPath}`)
  }

  return target
}

/**
 * 获取应用设置文件路径
 *
 * @returns ~/.proma/settings.json
 */
export function getSettingsPath(): string {
  return join(getConfigDir(), 'settings.json')
}

/**
 * 获取用户档案文件路径
 *
 * @returns ~/.proma/user-profile.json
 */
export function getUserProfilePath(): string {
  return join(getConfigDir(), 'user-profile.json')
}

/**
 * 获取代理配置文件路径
 *
 * @returns ~/.proma/proxy-settings.json
 */
export function getProxySettingsPath(): string {
  return join(getConfigDir(), 'proxy-settings.json')
}

/**
 * 获取系统提示词配置文件路径
 *
 * @returns ~/.proma/system-prompts.json
 */
export function getSystemPromptsPath(): string {
  return join(getConfigDir(), 'system-prompts.json')
}

/**
 * 获取记忆配置文件路径
 *
 * @returns ~/.proma/memory.json
 */
export function getMemoryConfigPath(): string {
  return join(getConfigDir(), 'memory.json')
}

/**
 * 获取 Chat 工具配置文件路径
 *
 * @returns ~/.proma/chat-tools.json
 */
export function getChatToolsConfigPath(): string {
  return join(getConfigDir(), 'chat-tools.json')
}

/**
 * 获取 MCP 服务器 client_secret 加密存储文件路径
 *
 * @returns ~/.proma/mcp-client-secrets.json
 */
export function getMcpClientSecretsPath(): string {
  return join(getConfigDir(), 'mcp-client-secrets.json')
}

/**
 * 获取 Agent 会话索引文件路径
 *
 * @returns ~/.proma/agent-sessions.json
 */
export function getAgentSessionsIndexPath(): string {
  return join(getConfigDir(), 'agent-sessions.json')
}

/** Goal 索引文件路径。Goal 的运行事件单独追加到 goals/ 目录，避免污染会话历史。 */
export function getAgentGoalsIndexPath(): string {
  return join(getConfigDir(), 'goals.json')
}

/** Goal 事件目录；按 Goal ID 保存 append-only JSONL 审计记录。 */
export function getAgentGoalsDir(): string {
  const dir = join(getConfigDir(), 'goals')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/** 指定 Goal 的事件日志路径。 */
export function getAgentGoalEventsPath(goalId: string): string {
  return join(getAgentGoalsDir(), `${goalId}.jsonl`)
}

/** Proactive Scheduler 的本地持久化目录。 */
export function getProactiveDir(): string {
  const dir = join(getConfigDir(), 'proactive')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getProactiveSchedulesPath(): string {
  return join(getProactiveDir(), 'schedules.json')
}

export function getProactiveRunsPath(): string {
  return join(getProactiveDir(), 'runs.json')
}

/**
 * 获取 Agent 会话消息目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.proma/agent-sessions/
 */
export function getAgentSessionsDir(): string {
  const dir = join(getConfigDir(), 'agent-sessions')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 会话目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定 Agent 会话的消息文件路径
 *
 * @param id 会话 ID
 * @returns ~/.proma/agent-sessions/{id}.jsonl
 */
export function getAgentSessionMessagesPath(id: string): string {
  return join(getAgentSessionsDir(), `${id}.jsonl`)
}

/**
 * 获取 Agent 工作区索引文件路径
 *
 * @returns ~/.proma/agent-workspaces.json
 */
export function getAgentWorkspacesIndexPath(): string {
  return join(getConfigDir(), 'agent-workspaces.json')
}

/**
 * 获取 Agent 工作区根目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.proma/agent-workspaces/
 */
export function getAgentWorkspacesDir(): string {
  const dir = join(getConfigDir(), 'agent-workspaces')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 工作区目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定 Agent 工作区的目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.proma/agent-workspaces/{slug}/
 */
export function getAgentWorkspacePath(slug: string): string {
  const dir = join(getAgentWorkspacesDir(), slug)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 工作区: ${dir}`)
  }

  return dir
}

/** 获取 Workflow Definition 根目录。 */
export function getWorkflowsDir(): string {
  const dir = join(getConfigDir(), 'workflows')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/** 本地 Workflow 模板目录；模板只保存无凭证的 Definition 快照。 */
export function getWorkflowTemplatesDir(): string {
  const dir = join(getWorkflowsDir(), 'templates')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Workflow/Run 标识符会参与本地路径拼接，必须拒绝路径分隔符和相对路径。 */
function assertWorkflowStorageIdentifier(value: string, label: 'Workflow' | 'Run'): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} ID 非法`)
  }
}

/** 获取单个 Workflow 的存储目录。 */
export function getWorkflowDir(workflowId: string): string {
  assertWorkflowStorageIdentifier(workflowId, 'Workflow')
  const dir = join(getWorkflowsDir(), workflowId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/** 获取 Workflow Definition 的原子快照文件。 */
export function getWorkflowDefinitionPath(workflowId: string): string {
  return join(getWorkflowDir(workflowId), 'definition.json')
}

export function getWorkflowTemplatePath(templateId: string): string {
  assertWorkflowStorageIdentifier(templateId, 'Workflow')
  return join(getWorkflowTemplatesDir(), `${templateId}.json`)
}

export function getWorkflowTemplateInstallationPath(workflowId: string): string {
  return join(getWorkflowDir(workflowId), 'template-installation.json')
}

/** 获取单个 Workflow 的 Run 目录。 */
export function getWorkflowRunsDir(workflowId: string): string {
  const dir = join(getWorkflowDir(workflowId), 'runs')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/** Workflow 定时调度的轻量状态：nextRunAt 仅属于调度器，不污染已发布 Definition。 */
export function getWorkflowSchedulerStatePath(): string {
  return join(getWorkflowsDir(), 'scheduler-state.json')
}

/** Workflow 审批主体与角色目录；未来可由企业 IdP/飞书同步服务覆盖。 */
export function getWorkflowIdentityDirectoryPath(): string {
  return join(getWorkflowsDir(), 'identity-directory.json')
}

/** 获取某次 Run 的快照文件。 */
export function getWorkflowRunPath(workflowId: string, runId: string): string {
  assertWorkflowStorageIdentifier(runId, 'Run')
  return join(getWorkflowRunsDir(workflowId), `${runId}.json`)
}

/** 获取某次 Run 的审计事件日志。 */
export function getWorkflowRunEventsPath(workflowId: string, runId: string): string {
  assertWorkflowStorageIdentifier(runId, 'Run')
  return join(getWorkflowRunsDir(workflowId), `${runId}.jsonl`)
}

/**
 * 获取指定工作区的 MCP 配置文件路径
 *
 * @param slug 工作区 slug
 * @returns ~/.proma/agent-workspaces/{slug}/mcp.json
 */
export function getWorkspaceMcpPath(slug: string): string {
  return join(getAgentWorkspacePath(slug), 'mcp.json')
}

/**
 * 获取指定工作区的 Skills 目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.proma/agent-workspaces/{slug}/skills/
 */
export function getWorkspaceSkillsDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'skills')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取工作区文件目录路径
 *
 * 工作区内所有会话可访问的文件存放于此。
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.proma/agent-workspaces/{slug}/workspace-files/
 */
export function getWorkspaceFilesDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'workspace-files')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取工作区不活跃 Skills 目录路径
 *
 * 禁用的 Skill 会被移动到此目录，Agent SDK 不会扫描该目录。
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.proma/agent-workspaces/{slug}/skills-inactive/
 */
export function getInactiveSkillsDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'skills-inactive')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取默认 Skills 模板目录路径
 *
 * 新建工作区时自动复制此目录的内容到工作区 skills/ 下。
 *
 * @returns ~/.proma/default-skills/
 */
export function getDefaultSkillsDir(): string {
  const dir = join(getConfigDir(), 'default-skills')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 从 SKILL.md 的 YAML frontmatter 中解析 version 字段
 *
 * 无 version 字段时返回 '0.0.0'（确保旧 Skill 会被更新）。
 */
export function parseSkillVersion(skillDir: string): string {
  const skillMdPath = join(skillDir, 'SKILL.md')
  if (!existsSync(skillMdPath)) return '0.0.0'

  try {
    const content = readFileSync(skillMdPath, 'utf-8')
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!fmMatch?.[1]) return '0.0.0'

    for (const line of fmMatch[1].split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
      if (key === 'version' && value) return value
    }
  } catch {
    // 解析失败视为最低版本
  }

  return '0.0.0'
}

/** 比较两个 semver 版本字符串
 *
 * @returns 正数表示 a > b，0 表示相等，负数表示 a < b
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 防御性目录基名集合：复制 default skills 时永远跳过这些目录，避免
 *  .git 0444 文件、node_modules 文件爆炸等场景把启动期同步链路炸掉。 */
const DEFAULT_SKILL_COPY_BLOCKLIST = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
  'dist',
  '.next',
  '.cache',
  '.turbo',
  '__pycache__',
])

function defaultSkillCopyFilter(src: string): boolean {
  return !DEFAULT_SKILL_COPY_BLOCKLIST.has(basename(src))
}

/**
 * 从 app bundle 同步默认 Skills 到 ~/.proma/default-skills/
 *
 * 打包模式下从 process.resourcesPath/default-skills 复制。
 * 开发模式下从源码 default-skills/ 目录复制。
 *
 * - 缺失的 Skill：直接复制
 * - 已存在的 Skill：比较 SKILL.md 中的 version，bundled 更新时才覆盖
 *   （避免每次启动同步 4MB+ 文件阻塞主进程）
 */
export function seedDefaultSkills(): void {
  const { app } = require('electron')
  const bundledDir = app.isPackaged
    ? join(process.resourcesPath, 'default-skills')
    : join(__dirname, '../default-skills')

  if (!existsSync(bundledDir)) {
    console.log('[配置] 未找到内置 default-skills 目录，跳过')
    return
  }

  const userDir = getDefaultSkillsDir()

  try {
    const entries = readdirSync(bundledDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const source = join(bundledDir, entry.name)
      const target = join(userDir, entry.name)

      try {
        if (!existsSync(target)) {
          cpSync(source, target, { recursive: true, filter: defaultSkillCopyFilter })
          console.log(`[配置] 已同步默认 Skill: ${entry.name}`)
          continue
        }

        const bundledVer = parseSkillVersion(source)
        const existingVer = parseSkillVersion(target)

        if (compareSemver(bundledVer, existingVer) > 0) {
          // rm-then-cp：rmSync 不依赖目标文件写权限（只读 .git/objects/ 等
          // 0444 文件用 cpSync({ force: true }) 无法覆盖会 EACCES，但
          // rmSync({ force: true }) 只需父目录可写就能 unlink）。
          rmSync(target, { recursive: true, force: true })
          cpSync(source, target, { recursive: true, filter: defaultSkillCopyFilter })
          console.log(`[配置] 已升级默认 Skill: ${entry.name} (${existingVer} → ${bundledVer})`)
        }
      } catch (err) {
        // 单 skill 失败不影响其他 skill 同步。这里吞错是为了防止启动期 bootstrap
        // 链路被任意一个 skill 的同步异常掀翻——窗口和托盘必须先出来。
        console.warn(`[配置] 同步默认 Skill 失败 (${entry.name})，跳过:`, err)
      }
    }
  } catch (err) {
    console.warn('[配置] 同步默认 Skills 失败:', err)
  }
}

/**
 * 获取微信配置文件路径
 *
 * @returns ~/.proma/wechat.json
 */
export function getWeChatConfigPath(): string {
  return join(getConfigDir(), 'wechat.json')
}

/**
 * 获取微信长轮询同步游标路径
 *
 * @returns ~/.proma/wechat-sync.json
 */
export function getWeChatSyncPath(): string {
  return join(getConfigDir(), 'wechat-sync.json')
}

/**
 * 获取钉钉配置文件路径
 *
 * @returns ~/.proma/dingtalk.json
 */
export function getDingTalkConfigPath(): string {
  return join(getConfigDir(), 'dingtalk.json')
}

/**
 * 获取飞书配置文件路径
 *
 * @returns ~/.proma/feishu.json
 */
export function getFeishuConfigPath(): string {
  return join(getConfigDir(), 'feishu.json')
}

/**
 * 获取飞书聊天绑定持久化路径
 *
 * @returns ~/.proma/feishu-bindings.json
 */
export function getFeishuBindingsPath(): string {
  return join(getConfigDir(), 'feishu-bindings.json')
}

/**
 * 获取某个飞书 Bot 的聊天绑定持久化路径
 *
 * @returns ~/.proma/feishu-bindings-{botId}.json
 */
export function getFeishuBotBindingsPath(botId: string): string {
  return join(getConfigDir(), `feishu-bindings-${botId}.json`)
}

/**
 * 获取指定 Agent 会话的工作路径
 *
 * 在工作区目录下创建以 sessionId 命名的子文件夹，
 * 作为该会话的独立 Agent cwd。如果目录不存在则自动创建。
 *
 * @param workspaceSlug 工作区 slug
 * @param sessionId 会话 ID
 * @returns ~/.proma/agent-workspaces/{slug}/{sessionId}/
 */
export function getAgentSessionWorkspacePath(workspaceSlug: string, sessionId: string): string {
  const dir = join(getAgentWorkspacePath(workspaceSlug), sessionId)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 会话工作目录: ${dir}`)
  }

  return dir
}

/**
 * 获取 SDK 隔离配置目录路径
 *
 * 用于设置 CLAUDE_CONFIG_DIR 环境变量，让 SDK 读取独立的配置文件，
 * 而不是用户的 ~/.claude.json，实现 Proma 与 Claude Code CLI 的配置隔离。
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.proma/sdk-config/
 */
export function getSdkConfigDir(): string {
  const dir = join(getConfigDir(), 'sdk-config')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 SDK 配置目录: ${dir}`)
  }

  return dir
}

/**
 * 获取 Scratch Pad 文件路径
 *
 * @returns ~/.proma/scratch-pad.md
 */
export function getScratchPadPath(): string {
  return join(getConfigDir(), 'scratch-pad.md')
}

/** 灵动岛扩展配置目录（开关/项目静音等，刻意不写入 settings.json）。 */
export function getDynamicIslandDir(): string {
  const dir = join(getConfigDir(), 'dynamic-island')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/** 灵动岛配置文件路径。 */
export function getDynamicIslandConfigPath(): string {
  return join(getDynamicIslandDir(), 'config.json')
}

// ==================== 工作模块（项目管理 / 日程管家）路径 ====================

/**
 * 获取日程事件文件路径
 *
 * @returns ~/.proma-mit/calendar/events.jsonl
 */
export function getCalendarEventsPath(): string {
  return join(getConfigDir(), 'calendar', 'events.jsonl')
}

/**
 * 获取日程事件目录路径
 *
 * @returns ~/.proma-mit/calendar/
 */
export function getCalendarDir(): string {
  const dir = join(getConfigDir(), 'calendar')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/**
 * 获取日程任务文件路径
 *
 * @returns ~/.proma-mit/calendar/tasks.jsonl
 */
export function getTasksPath(): string {
  return join(getConfigDir(), 'calendar', 'tasks.jsonl')
}

/**
 * 获取项目管理目录路径
 *
 * @returns ~/.proma-mit/projects/
 */
export function getProjectsDir(): string {
  const dir = join(getConfigDir(), 'projects')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建项目管理目录: ${dir}`)
  }
  return dir
}

/**
 * 获取营销能力目录（领域包数据 / 订阅状态）
 *
 * @returns ~/.proma-mit/marketing/
 */
export function getMarketingDir(): string {
  const dir = join(getConfigDir(), 'marketing')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建营销能力目录: ${dir}`)
  }
  return dir
}
