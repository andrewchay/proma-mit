import { createHash } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ProjectOwnerPlanDraft } from '@gravitas/shared'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getAgentWorkspacePath } from './config-paths'
import { hasProjectWorkspaceBinding } from './project-workspace-bindings'
import { getProject, getProjectDb } from './project-sqlite-store'

const DOCUMENT_RELATIVE_PATH = join('docs', 'owner-planning-log.md')
const DOC_ARCHIVE_WARNING = '项目文档归档失败；规划内容仍保存在应用账本中。请检查项目工作区后刷新重试。'

function marker(projectId: string, plan: ProjectOwnerPlanDraft): string {
  const event = `${projectId}:${plan.planVersion}:${plan.state}:${plan.planFingerprint}`
  return `<!-- owner-planning:${createHash('sha256').update(event).digest('hex')} -->`
}

function escapeMarkdown(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1')
}

function bullets(values: string[]): string {
  return values.length ? values.map((value) => `- ${escapeMarkdown(value)}`).join('\n') : '- 无'
}

function headingText(value: string): string {
  return escapeMarkdown(value.replace(/[\r\n]+/g, ' '))
}

function renderPlanEvent(projectTitle: string, plan: ProjectOwnerPlanDraft, eventMarker: string): string {
  const timestamp = new Date(plan.savedAt).toISOString()
  const state = plan.state === 'confirmed' ? '已确认内容' : plan.state === 'stale' ? '来源已变化' : '待审阅'
  const taskTitle = plan.sources.task ? ` · ${headingText(plan.sources.task.title)}` : ''
  if (plan.state !== 'proposed') {
    return `\n## ${headingText(projectTitle)}${taskTitle} · 计划 v${plan.planVersion} · ${state}\n\n${timestamp}\n\n${eventMarker}\n`
  }
  const steps = plan.proposal.steps.map((step, index) => [
    `${index + 1}. **${escapeMarkdown(step.title)}**`,
    `   - 预期成果：${escapeMarkdown(step.outcome)}`,
    `   - 完成标准：${step.acceptanceCriteria.map(escapeMarkdown).join('；') || '无'}`,
    `   - 岗位建议：${escapeMarkdown(plan.sources.roles.find((role) => role.key === step.roleKey)?.name ?? step.roleKey)}`,
    `   - 依赖：${step.dependencies.map(escapeMarkdown).join('、') || '无'}`,
  ].join('\n')).join('\n')
  return [
    '',
    `## ${headingText(projectTitle)}${taskTitle} · 计划 v${plan.planVersion} · ${state}`,
    '',
    timestamp,
    '',
    '**计划摘要**',
    escapeMarkdown(plan.proposal.summary),
    '',
    '**计划假设**',
    bullets(plan.proposal.assumptions),
    '',
    '**计划风险**',
    bullets(plan.proposal.risks),
    '',
    '**计划步骤**',
    steps,
    '',
    '以上内容是 Owner 规划记录，不代表执行授权、任务已派发或成果已验收。',
    '',
    eventMarker,
    '',
  ].join('\n')
}

function isWithinRoot(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function appendAtRoot(rootPath: string, projectTitle: string, projectId: string, plans: ProjectOwnerPlanDraft[]): void {
  const root = realpathSync(rootPath)
  if (!lstatSync(root).isDirectory()) throw new Error('项目工作区根目录无效')
  const docsPath = join(root, 'docs')
  if (existsSync(docsPath)) {
    const docsStat = lstatSync(docsPath)
    if (docsStat.isSymbolicLink() || !docsStat.isDirectory()) throw new Error('项目 docs 目录不是安全目录')
  } else {
    mkdirSync(docsPath, { mode: 0o755 })
  }
  const docsRoot = realpathSync(docsPath)
  if (!isWithinRoot(root, docsRoot)) throw new Error('项目 docs 目录越出工作区')
  const filePath = join(docsRoot, 'owner-planning-log.md')
  if (existsSync(filePath)) {
    const fileStat = lstatSync(filePath)
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.nlink > 1) throw new Error('项目规划文档不是普通文件')
    if (!isWithinRoot(docsRoot, realpathSync(filePath))) throw new Error('项目规划文档越出工作区')
  }
  for (const plan of plans) {
    if (plan.projectId !== projectId) continue
    const eventMarker = marker(projectId, plan)
    if (existsSync(filePath) && readFileSync(filePath, 'utf8').includes(eventMarker)) continue
    const needsHeader = !existsSync(filePath) || lstatSync(filePath).size === 0
    const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
    const descriptor = openSync(filePath, flags, 0o600)
    try {
      const stat = fstatSync(descriptor)
      if (!stat.isFile() || stat.nlink > 1) throw new Error('项目规划文档不是普通文件')
      const entry = renderPlanEvent(projectTitle, plan, eventMarker)
      const content = Buffer.from(`${needsHeader ? '# Owner 规划记录\n\n' : ''}${entry}`, 'utf8')
      let offset = 0
      while (offset < content.length) offset += writeSync(descriptor, content, offset, content.length - offset)
    } finally {
      closeSync(descriptor)
    }
  }
}

/**
 * 将已保存计划历史同步到固定项目文档。调用方只能传结构化计划，路径始终由Owner绑定解析。
 * 返回null表示成功或没有可归档计划；统一告警不泄露本地绝对路径。
 */
export function archiveProjectOwnerPlanHistory(projectId: string, plans: ProjectOwnerPlanDraft[]): string | null {
  if (!plans.length) return null
  try {
    const project = getProject(projectId)
    if (!project) throw new Error('项目不存在')
    const rows = getProjectDb().prepare('SELECT revision, payload FROM project_owner_runtime_revisions WHERE project_id = ? ORDER BY revision').all(projectId) as { revision: number; payload: string }[]
    const current = rows.at(-1)
    if (!current || current.revision !== rows.length) throw new Error('Owner规划工作区绑定不存在')
    const binding = JSON.parse(current.payload) as Record<string, unknown>
    const allowedFields = ['schemaVersion', 'projectId', 'revision', 'ownerRole', 'ownerName', 'carrierId', 'workspaceId', 'channelId', 'modelId', 'runtime', 'carrierFingerprint', 'carrierConfigurationFingerprint', 'actor', 'savedAt', 'changeReason']
    if (Object.keys(binding).some((key) => !allowedFields.includes(key)) || binding.schemaVersion !== 1 || binding.projectId !== projectId || binding.revision !== current.revision || binding.ownerRole !== 'project_owner' || binding.runtime !== 'ai-sdk' || binding.actor !== 'local-user' || typeof binding.carrierId !== 'string' || typeof binding.workspaceId !== 'string' || !binding.workspaceId.trim() || typeof binding.channelId !== 'string' || typeof binding.modelId !== 'string' || typeof binding.carrierFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(binding.carrierFingerprint)) throw new Error('Owner规划工作区绑定无效')
    const workspaceId = binding.workspaceId
    if (!hasProjectWorkspaceBinding(projectId, workspaceId)) throw new Error('Owner规划工作区未获项目授权')
    const workspace = getAgentWorkspace(workspaceId)
    if (!workspace) throw new Error('Owner规划工作区不存在')
    const root = workspace.rootPath ?? getAgentWorkspacePath(workspace.slug)
    const scopedPlans = plans.filter((plan) => plan.projectId === projectId)
    appendAtRoot(root, project.title, projectId, scopedPlans)
    return null
  } catch {
    return DOC_ARCHIVE_WARNING
  }
}

/** 供隔离文件系统测试使用；生产入口必须先经 archiveProjectOwnerPlanHistory 授权解析。 */
export function appendProjectOwnerPlanArchiveAtRoot(rootPath: string, projectId: string, projectTitle: string, plans: ProjectOwnerPlanDraft[]): void {
  if (!rootPath || !projectId || !projectTitle || isAbsolute(DOCUMENT_RELATIVE_PATH) || dirname(DOCUMENT_RELATIVE_PATH) !== 'docs') throw new Error('项目规划文档参数无效')
  appendAtRoot(rootPath, projectTitle, projectId, plans)
}
