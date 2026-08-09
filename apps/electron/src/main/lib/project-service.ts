/**
 * 项目管理服务 — Project Service
 *
 * 本地 SQLite 作为唯一数据源（弃用 NocoBase）。
 * 所有数据操作通过 project-sqlite-store 完成，对外接口保持不变。
 *
 * v1.0 — 本地 SQLite 唯一数据源
 */

import { getSettings, onSettingsChange } from './settings-service'
import * as store from './project-sqlite-store'
import { generateProjectSummary, type ProjectSummary } from './project-summary-service'
import type {
  Project,
  Task,
  MeetingNote,
  UserMapping,
  CreateProjectInput,
  CreateTaskInput,
  ListTasksFilter,
  KanbanBoard,
  ProjectProgress,
  SaveUserMappingInput,
  ImportAndExtractResult,
  SubTask,
  CreateExecutionSubTaskInput,
  TodoRetryEvent,
  TaskDependency,
  TaskDependencyType,
  TaskBlocker,
  MyWorkItem,
  ProjectActivity,
  ProjectTemplate,
} from './project-types'

export type {
  ProjectStatus,
  TaskStatus,
  TaskPriority,
  TaskAssignee,
  SubTask,
  Project,
  Task,
  MeetingNote,
  UserMapping,
  CreateProjectInput,
  CreateTaskInput,
  ListTasksFilter,
  KanbanBoard,
  ProjectProgress,
  SaveUserMappingInput,
  ImportAndExtractResult,
  ExecutableWorkItem,
  ExecutableWorkItemType,
  CreateExecutionSubTaskInput,
  TodoRetryEvent,
  TaskDependency,
  TaskDependencyType,
  TaskBlocker,
  MyWorkItem,
  ProjectActivity,
  ProjectTemplate,
} from './project-types'
export type { ProjectSummary } from './project-summary-service'

// ===== 任务变更回调（供自动同步等模块注册） =====

export type TaskChangeAction = 'created' | 'updated' | 'deleted' | 'draft_confirmed'

type TaskChangeListener = (task: Task | null, action: TaskChangeAction) => void

const taskChangeListeners = new Set<TaskChangeListener>()

/** 注册任务变更监听（返回取消函数）。用于钉钉待办自动推送/回写等副作用。 */
export function onTaskChange(listener: TaskChangeListener): () => void {
  taskChangeListeners.add(listener)
  return () => {
    taskChangeListeners.delete(listener)
  }
}

function fireTaskChange(task: Task | null, action: TaskChangeAction): void {
  for (const listener of taskChangeListeners) {
    try {
      listener(task, action)
    } catch (error) {
      console.error('[ProjectService] 任务变更监听器执行失败:', error)
    }
  }
}

// ===== 项目 CRUD =====

export async function createProject(input: CreateProjectInput): Promise<Project> {
  return store.createProject(input)
}

export async function listProjects(): Promise<Project[]> {
  return store.listProjects()
}

export async function getProject(id: string): Promise<Project | null> {
  return store.getProject(id)
}

export async function updateProject(id: string, updates: Partial<Omit<Project, 'id' | 'createdAt'>>): Promise<Project | null> {
  return store.updateProject(id, updates)
}

export async function deleteProject(id: string): Promise<boolean> {
  return store.deleteProject(id)
}

// ===== 任务 CRUD =====

export async function createTask(projectId: string, input: CreateTaskInput): Promise<Task> {
  const task = store.createTask(projectId, input)
  fireTaskChange(task, 'created')
  return task
}

export async function listTasks(projectId: string, filter?: ListTasksFilter): Promise<Task[]> {
  return store.listTasks(projectId, filter)
}

export async function getTask(id: string): Promise<Task | null> {
  return store.getTask(id)
}

export async function updateTask(id: string, updates: Partial<Omit<Task, 'id' | 'projectId' | 'createdAt'>>): Promise<Task | null> {
  const task = store.updateTask(id, updates)
  if (task) fireTaskChange(task, 'updated')
  return task
}

export async function deleteTask(id: string): Promise<boolean> {
  const task = await getTask(id)
  const result = store.deleteTask(id)
  if (result && task) fireTaskChange(null, 'deleted')
  return result
}

// ===== 子任务 =====

export async function createSubTask(parentId: string, input: Omit<CreateTaskInput, 'parentId'>): Promise<Task | null> {
  return store.createSubTask(parentId, input)
}

export async function listSubTasks(parentId: string): Promise<Task[]> {
  return store.listSubTasks(parentId)
}

/** 独立执行 subTask：归属 Task，但不属于 WBS 层级。 */
export async function createExecutionSubTask(taskId: string, input: CreateExecutionSubTaskInput): Promise<SubTask | null> {
  return store.createExecutionSubTask(taskId, input)
}

export async function listExecutionSubTasks(taskId: string): Promise<SubTask[]> {
  return store.listExecutionSubTasks(taskId)
}

export function updateExecutionSubTask(
  id: string,
  updates: Partial<Omit<SubTask, 'id' | 'taskId' | 'projectId' | 'entityType' | 'createdAt'>>,
): Promise<SubTask | null> {
  return Promise.resolve(store.updateExecutionSubTask(id, updates))
}

export async function deleteExecutionSubTask(id: string): Promise<boolean> {
  return store.deleteExecutionSubTask(id)
}

export async function listDingTalkTodoRetries(projectId: string): Promise<TodoRetryEvent[]> {
  return store.listDingTalkTodoRetries(projectId)
}

export async function retryDingTalkTodo(eventId: string): Promise<boolean> {
  // 真正重新执行同步动作（按 outbox 事件类型分发）
  const { retryOutboxEvent } = await import('./project-auto-sync')
  return retryOutboxEvent(eventId)
}

/**
 * 钉钉 Todo 凭证持久化（本地设置）。
 *
 * PAA 是凭证唯一来源：App Secret 仅保存在 Bot Hub 的 Electron safeStorage 中，
 * 此处将 appKey/enabled 状态写入本地设置；实际调用由 dingtalk-todo-provider 完成。
 */
export async function syncProjectDingTalkTodoConfig(): Promise<void> {
  // 本地方案无需把凭证同步到远端；验证配置完整性即可。
  const settings = getSettings()
  const todoConfig = settings.dingtalkTodo
  if (!todoConfig?.enabled) return

  let appKey = todoConfig.appKey ?? ''
  let appSecret = todoConfig.appSecret ?? ''
  if (todoConfig.botId) {
    const { getDingTalkBotById, getDecryptedBotClientSecret } = await import('./dingtalk-config')
    const bot = getDingTalkBotById(todoConfig.botId)
    if (!bot?.clientId) throw new Error('所选钉钉 Bot 不存在或未配置 App ID')
    appKey = bot.clientId
    appSecret = getDecryptedBotClientSecret(bot.id)
  }
  if (!appKey || !appSecret) {
    throw new Error('请先在「Bot Hub → 钉钉」配置并保存 App ID 和 App Secret')
  }
}

// ===== 任务草稿模式 =====

export async function createTaskDraft(projectId: string, input: CreateTaskInput): Promise<Task> {
  return store.createTaskDraft(projectId, input)
}

export async function confirmTaskDraft(id: string): Promise<Task | null> {
  const task = store.confirmTaskDraft(id)
  if (task) fireTaskChange(task, 'draft_confirmed')
  return task
}

export async function rejectTaskDraft(id: string): Promise<boolean> {
  return store.rejectTaskDraft(id)
}

// ===== 会议纪要 =====

export function importMeetingNote(
  projectId: string,
  input: { title: string; rawContent: string; extractedTaskIds?: string[] }
): Promise<MeetingNote> {
  return Promise.resolve(store.importMeetingNote(projectId, input))
}

export async function listMeetingNotes(projectId: string): Promise<MeetingNote[]> {
  return store.listMeetingNotes(projectId)
}

export async function getMeetingNote(id: string): Promise<MeetingNote | null> {
  return store.getMeetingNote(id)
}

export async function importMeetingNoteAndExtractTasks(
  projectId: string,
  input: { title: string; rawContent: string },
  llmCaller: import('./project-agent-service.ts').LLMCaller
): Promise<ImportAndExtractResult> {
  // 1. Agent 先提取任务
  const { extractTasksFromMeetingNote, extractedTaskToDraftInput } = await import('./project-agent-service.ts')
  const extractedTasks = await extractTasksFromMeetingNote(input.rawContent, llmCaller)

  // 2. 导入会议纪要
  const note = store.importMeetingNote(projectId, {
    title: input.title,
    rawContent: input.rawContent,
  })

  // 3. 创建任务草稿
  const drafts: Task[] = []
  for (const extracted of extractedTasks) {
    const draftInput = extractedTaskToDraftInput(extracted)
    const draft = store.createTaskDraft(projectId, draftInput)
    drafts.push(draft)
  }

  // 4. 更新纪要关联的任务 ID
  if (drafts.length > 0) {
    store.updateMeetingNoteExtractedTasks(note.id, drafts.map((d) => d.id))
  }

  return { note, drafts }
}

/**
 * 从钉钉文档自动拉取内容并提取任务草稿（会议文档 → tasks/subtasks）。
 *
 * @param projectId 目标项目
 * @param docUrl 钉钉在线文档链接
 * @param llmCaller LLM 调用器
 * @returns 导入的会议纪要 + 生成的任务草稿
 */
export async function importDingTalkDocAndExtractTasks(
  projectId: string,
  docUrl: string,
  llmCaller: import('./project-agent-service.ts').LLMCaller
): Promise<ImportAndExtractResult> {
  const { createDingTalkDocFetcherFromConfig } = await import('./dingtalk-doc-fetcher')
  const fetcher = await createDingTalkDocFetcherFromConfig()
  if (!fetcher) {
    throw new Error('钉钉文档拉取器未就绪：请先在「Bot Hub → 钉钉」配置并保存 App ID / App Secret，并开启钉钉文档权限')
  }
  const doc = await fetcher.fetchDoc(docUrl)
  return importMeetingNoteAndExtractTasks(projectId, { title: doc.title, rawContent: doc.content }, llmCaller)
}

/**
 * 从飞书文档自动拉取内容并提取任务草稿（会议文档 → tasks/subtasks）。
 *
 * @param projectId 目标项目
 * @param docUrl 飞书文档链接（docx / sheets / wiki）
 * @param llmCaller LLM 调用器
 * @returns 导入的会议纪要 + 生成的任务草稿
 */
export async function importFeishuDocAndExtractTasks(
  projectId: string,
  docUrl: string,
  llmCaller: import('./project-agent-service.ts').LLMCaller
): Promise<ImportAndExtractResult> {
  const { createFeishuDocFetcherFromConfig } = await import('./feishu-doc-fetcher')
  const fetcher = await createFeishuDocFetcherFromConfig()
  if (!fetcher) {
    throw new Error('飞书文档拉取器未就绪：请先在「Bot Hub → 飞书」配置并启用飞书 Todo 同步（使用 Bot 凭证），并在飞书开放平台为企业应用开通文档/表格/知识库读取权限')
  }
  const doc = await fetcher.fetchDoc(docUrl)
  return importMeetingNoteAndExtractTasks(projectId, { title: doc.title, rawContent: doc.content }, llmCaller)
}

// ===== 看板与进度 =====

export async function getKanbanBoard(projectId: string): Promise<KanbanBoard> {
  return store.getKanbanBoard(projectId)
}

export async function getProjectProgress(projectId: string): Promise<ProjectProgress> {
  return store.getProjectProgress(projectId)
}

export async function listTaskDependencies(projectId: string): Promise<TaskDependency[]> {
  return store.listTaskDependencies(projectId)
}

export async function createTaskDependency(taskId: string, dependsOnTaskId: string, type?: TaskDependencyType): Promise<TaskDependency> {
  return store.createTaskDependency(taskId, dependsOnTaskId, type)
}

export async function deleteTaskDependency(id: string): Promise<boolean> {
  return store.deleteTaskDependency(id)
}

export async function listTaskBlockers(projectId: string): Promise<TaskBlocker[]> {
  return store.listTaskBlockers(projectId)
}

export async function listProjectWorkItems(projectId: string): Promise<MyWorkItem[]> {
  return store.listProjectWorkItems(projectId)
}

export async function listMyWork(assigneeUserId: string): Promise<MyWorkItem[]> {
  return store.listMyWork(assigneeUserId)
}

/** PH2-⑤：我发起/指派的任务（“我指派的”视图） */
export async function listTasksCreatedBy(creatorUserId: string): Promise<MyWorkItem[]> {
  return store.listTasksCreatedBy(creatorUserId)
}

export async function listProjectActivities(projectId: string): Promise<ProjectActivity[]> {
  return store.listProjectActivities(projectId)
}

export async function listProjectTemplates(): Promise<ProjectTemplate[]> {
  return store.listProjectTemplates()
}

export async function createProjectTemplateFromProject(projectId: string, name: string, description?: string): Promise<ProjectTemplate> {
  return store.createProjectTemplateFromProject(projectId, name, description)
}

export async function applyProjectTemplate(templateId: string, projectName: string): Promise<Project> {
  return store.applyProjectTemplate(templateId, projectName)
}

/** 用户在界面明确点击后，才将已经预览的摘要发往配置的钉钉机器人。 */
export async function sendProjectSummaryToDingTalk(projectId: string): Promise<ProjectSummary> {
  const summary = await generateProjectSummary(projectId)
  // 本地方案：钉钉消息通过 DingtalkTodoProvider / 机器人 Webhook 发送。
  const { sendDingTalkRobotMessage } = await import('./dingtalk-todo-provider')
  await sendDingTalkRobotMessage({
    title: `${summary.title} 项目摘要`,
    text: summary.markdown,
  })
  return summary
}

/** 目标必须是用户已绑定的飞书 chatId，避免向未知群聊投递。 */
export async function sendProjectSummaryToFeishu(projectId: string, chatId: string): Promise<ProjectSummary> {
  const summary = await generateProjectSummary(projectId)
  // 飞书桥接依赖 Electron safeStorage；延迟加载使项目数据服务可在 Bun 集成测试中独立运行。
  const { feishuBridgeManager } = await import('./feishu-bridge-manager')
  await feishuBridgeManager.sendProjectSummary(chatId, summary.markdown)
  return summary
}

// ===== 用户映射 =====

export async function saveUserMapping(input: SaveUserMappingInput): Promise<UserMapping> {
  return store.saveUserMapping(input)
}

export async function getUserMapping(paaUserId: string): Promise<UserMapping | null> {
  return store.getUserMapping(paaUserId)
}

export async function listUserMappings(): Promise<UserMapping[]> {
  return store.listUserMappings()
}

export async function deleteUserMapping(paaUserId: string): Promise<boolean> {
  return store.deleteUserMapping(paaUserId)
}
