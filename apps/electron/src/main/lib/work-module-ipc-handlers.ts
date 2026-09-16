/**
 * 工作模块 IPC 处理器注册（项目管理 / 日程管家 / 日历同步）
 *
 * 由 ~/LLM/PAA 的 paa-ipc-handlers.ts 中 project / schedule / calendar-sync 三个
 * 子模块的处理器迁移而来，桥接渲染进程 IPC 调用到主进程服务层。
 */

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { PROJECT_CHAIN_IPC } from '@gravitas/shared'
import { getProjectChain, updateProjectChain } from './project-chain-service'
import {
  SCHEDULE_IPC_CHANNELS,
  CALENDAR_SYNC_IPC_CHANNELS,
  PROJECT_IPC_CHANNELS,
  AGENT_EMPLOYEE_IPC_CHANNELS,
  INFLUENCER_IPC_CHANNELS,
  PAID_MEDIA_IPC_CHANNELS,
  CREATIVE_IPC_CHANNELS,
  NEW_MEDIA_IPC_CHANNELS,
} from '@gravitas/shared'

// ===== 日程管家服务 =====
import { marketingService, ensureMarketingReady } from './marketing/marketing-service'
import { creativeVideoService } from './marketing/marketing-service'
import {
  listScheduleEvents,
  getScheduleEvent,
  createScheduleEvent,
  updateScheduleEvent,
  deleteScheduleEvent,
  bulkCreateScheduleEvents,
  getUpcomingEvents,
  scheduleAgentQuery,
  listScheduleTasks,
  getScheduleTask,
  createScheduleTask,
  updateScheduleTask,
  updateTaskStatus,
  deleteScheduleTask,
  detectConflicts,
  listScheduleEventsExpanded,
} from './schedule-service'
import {
  parseScheduleNlp,
  nlpResultToEventInput,
} from './schedule-nlp'

// ===== 日历同步服务 =====
import {
  checkCalendarPermission,
  requestCalendarPermission,
  readSystemCalendar,
  syncSystemCalendarToGravitas,
} from './calendar-eventkit-bridge'
import {
  listCalendarSources,
  getCalendarSource,
  createCalendarSource,
  updateCalendarSource,
  deleteCalendarSource,
  syncCalendarSource,
  syncAllCalendarSources,
  resolveSyncConflict,
  getLastSyncTime,
} from './calendar-sync-service'

// ===== 项目管理服务 =====
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  listTasks,
  getTask,
  createTask,
  createSubTask,
  listSubTasks,
  createExecutionSubTask,
  listExecutionSubTasks,
  updateExecutionSubTask,
  deleteExecutionSubTask,
  listDingTalkTodoRetries,
  retryDingTalkTodo,
  listTaskDependencies,
  createTaskDependency,
  deleteTaskDependency,
  listTaskBlockers,
  listProjectWorkItems,
  listMyWork,
  listProjectActivities,
  listProjectTemplates,
  createProjectTemplateFromProject,
  applyProjectTemplate,
  sendProjectSummaryToDingTalk,
  sendProjectSummaryToFeishu,
  updateTask,
  deleteTask,
  createTaskDraft,
  confirmTaskDraft,
  rejectTaskDraft,
  importMeetingNote,
  listMeetingNotes,
  getMeetingNote,
  getKanbanBoard,
  getProjectProgress,
  listTaskStatuses,
  createTaskStatus,
  updateTaskStatusDef,
  deleteTaskStatus,
  reorderTaskStatuses,
  reorderTask,
  saveUserMapping,
  getUserMapping,
  listUserMappings,
  deleteUserMapping,
} from './project-service'
import {
  syncTaskById,
  getSyncStatusById,
  getTaskExternalSyncInfo,
} from './project-sync-service'
import {
  assessTaskRisk,
  saveCompletionNotes,
} from './project-risk-service'
import {
  generateProjectRiskReport,
} from './project-risk-report-service'
import { listProjectAlerts } from './project-alert-service'
import { generateProjectSummary } from './project-summary-service'
import {
  createPollingTimer,
  registerPollingProvider,
  unregisterPollingProvider,
  getPollingProvider,
} from './project-polling-service'
import {
  registerTodoProvider,
  unregisterTodoProvider,
} from './project-sync-service'
import {
  createFeishuTodoProviderFromConfig,
} from './feishu-todo-provider'
import {
  createDingtalkTodoProviderFromConfig,
} from './dingtalk-todo-provider'
import { createLlmCaller } from './project-agent-service'
import { registerProjectAutoSync } from './project-auto-sync'
import {
  registerAgentEmployeeProvider,
  listAgentEmployees,
  getAgentEmployee,
  createAgentEmployee,
  updateAgentEmployee,
  deleteAgentEmployee,
  listAgentExecutionsByEntity,
  listAgentExecutionsByAgent,
  cancelAgentExecution,
  listAgentEmployeeCapabilityVersions,
  listAgentEmployeeLearningSamples,
  excludeAgentEmployeeLearningSample,
  reviewAgentEmployeeLearningSample,
  getAgentEmployeeCapabilityObservations,
  rollbackAgentEmployeeCapabilityVersion,
  listAgentEmployeeCapabilityRollbackAudits,
  getAgentEmployeeCapabilityHealth,
} from './agent-employee-service'
import { runEmployeeCapabilityEvaluation } from './agent-employee-evaluation-service'
import { disableEmployeeCanary, enableEmployeeCanary, listEmployeeCanaryConfigs, pauseEmployeeCanary } from './agent-employee-canary'
import { detectCapabilityConflicts } from './agent-employee-capability-conflict'
import { getGovernancePolicy, listGovernanceAudits, updateGovernancePolicy } from './employee-capability-governance-policy'
import { buildEmployeeCapabilityReviewReport } from './employee-capability-ledger'
import { exportEvolutionPackage, summarizeEvolutionPackageForReview, validateEvolutionPackage } from './employee-capability-portability'
import { deleteAgentEmployeeLearningSamples, getAgentEmployeeCapabilityDependencyGraph, previewAgentEmployeeLearningSampleRetention } from './project-sqlite-store'
import { onSettingsChange } from './settings-service'
import {
  listChannels,
  decryptApiKey,
} from './channel-manager'

// ===== 注册函数 =====

/** 项目中所有外部状态轮询的停止函数 */
const pollingTimers = new Map<string, () => void>()

/** 停止并清理所有项目轮询 */
function stopAllProjectPolling(): void {
  for (const [key, stop] of pollingTimers.entries()) {
    stop()
    console.log(`[ProjectPolling] 配置变更，已停止 ${key} 轮询`)
  }
  pollingTimers.clear()
}

/** 初始化项目 Todo Provider（飞书 + 钉钉） */
function initProjectTodoProviders(): void {
  // 重新初始化前：停止所有轮询并注销旧 Provider
  stopAllProjectPolling()
  unregisterTodoProvider('feishu')
  unregisterTodoProvider('dingtalk')
  unregisterPollingProvider('feishu')
  unregisterPollingProvider('dingtalk')

  // 注册飞书 Todo Provider
  try {
    const feishuProvider = createFeishuTodoProviderFromConfig()
    if (feishuProvider) {
      registerTodoProvider(feishuProvider)
      registerPollingProvider({
        name: 'feishu',
        async queryStatus(externalTaskId: string, options?: { unionId?: string }) {
          return feishuProvider.queryTodoStatus(externalTaskId, options)
        },
      })
      console.log('[ProjectTodoProviders] 飞书 Todo Provider 已注册')
    } else {
      console.log('[ProjectTodoProviders] 飞书配置未找到，跳过注册')
    }
  } catch (error) {
    console.error('[ProjectTodoProviders] 飞书 Provider 注册失败:', error)
  }

  // 注册钉钉 Todo Provider
  try {
    const dingtalkProvider = createDingtalkTodoProviderFromConfig()
    if (dingtalkProvider) {
      registerTodoProvider(dingtalkProvider)
      registerPollingProvider({
        name: 'dingtalk',
        async queryStatus(externalTaskId: string, options?: { unionId?: string }) {
          return dingtalkProvider.queryTodoStatus(externalTaskId, options)
        },
      })
      console.log('[ProjectTodoProviders] 钉钉 Todo Provider 已注册')
    } else {
      console.log('[ProjectTodoProviders] 钉钉配置未找到，跳过注册')
    }
  } catch (error) {
    console.error('[ProjectTodoProviders] 钉钉 Provider 注册失败:', error)
  }
}

export function registerWorkModuleIpcHandlers(): void {
  console.log('[IPC] 正在注册工作模块 IPC 处理器（日程管家 / 日历同步 / 项目管理）...')

  // ============================================
  // 1. 日程管家
  // ============================================

  ipcMain.handle(SCHEDULE_IPC_CHANNELS.LIST_EVENTS, async (_, filter) => {
    return listScheduleEvents(filter)
  })

  ipcMain.handle(SCHEDULE_IPC_CHANNELS.GET_EVENT, async (_, id: string) => {
    return getScheduleEvent(id)
  })

  ipcMain.handle(SCHEDULE_IPC_CHANNELS.CREATE_EVENT, async (_, input) => {
    return createScheduleEvent(input)
  })

  ipcMain.handle(SCHEDULE_IPC_CHANNELS.UPDATE_EVENT, async (_, id: string, patch) => {
    return updateScheduleEvent(id, patch)
  })

  ipcMain.handle(SCHEDULE_IPC_CHANNELS.DELETE_EVENT, async (_, id: string) => {
    return deleteScheduleEvent(id)
  })

  ipcMain.handle(SCHEDULE_IPC_CHANNELS.BULK_CREATE_EVENTS, async (_, inputs) => {
    return bulkCreateScheduleEvents(inputs)
  })

  ipcMain.handle(SCHEDULE_IPC_CHANNELS.GET_UPCOMING_EVENTS, async (_, minutesAhead?: number) => {
    return getUpcomingEvents(minutesAhead)
  })

  ipcMain.handle(SCHEDULE_IPC_CHANNELS.AGENT_QUERY, async (_, query, context) => {
    return scheduleAgentQuery(query, context)
  })

  // NLP 自然语言解析
  ipcMain.handle(SCHEDULE_IPC_CHANNELS.PARSE_NLP, async (_, text: string) => {
    return parseScheduleNlp(text)
  })

  ipcMain.handle(SCHEDULE_IPC_CHANNELS.CREATE_FROM_NLP, async (_, text: string) => {
    const nlpResult = parseScheduleNlp(text)
    if (!nlpResult.success) {
      return { success: false, error: nlpResult.error, event: null }
    }
    const input = nlpResultToEventInput(nlpResult)
    if (!input) {
      return { success: false, error: '无法转换为事件', event: null }
    }
    const event = createScheduleEvent(input)
    return { success: true, event }
  })

  // 任务管理
  ipcMain.handle(SCHEDULE_IPC_CHANNELS.LIST_TASKS, async (_, filter) => {
    return listScheduleTasks(filter)
  })

  ipcMain.handle(SCHEDULE_IPC_CHANNELS.GET_TASK, async (_, id: string) => {
    return getScheduleTask(id)
  })

  ipcMain.handle(SCHEDULE_IPC_CHANNELS.CREATE_TASK, async (_, input) => {
    return createScheduleTask(input)
  })

  ipcMain.handle(SCHEDULE_IPC_CHANNELS.UPDATE_TASK, async (_, id: string, patch) => {
    return updateScheduleTask(id, patch)
  })

  ipcMain.handle(SCHEDULE_IPC_CHANNELS.UPDATE_TASK_STATUS, async (_, id: string, status) => {
    return updateTaskStatus(id, status)
  })

  ipcMain.handle(SCHEDULE_IPC_CHANNELS.DELETE_TASK, async (_, id: string) => {
    return deleteScheduleTask(id)
  })

  // 冲突检测
  ipcMain.handle(SCHEDULE_IPC_CHANNELS.DETECT_CONFLICTS, async (_, event, excludeId) => {
    return detectConflicts(event, excludeId)
  })

  // 展开重复事件
  ipcMain.handle(SCHEDULE_IPC_CHANNELS.LIST_EVENTS_EXPANDED, async (_, filter, maxInstances) => {
    return listScheduleEventsExpanded(filter, maxInstances)
  })

  // ============================================
  // 2. 日历同步
  // ============================================

  ipcMain.handle(CALENDAR_SYNC_IPC_CHANNELS.LIST_SOURCES, async () => {
    return listCalendarSources()
  })

  ipcMain.handle(CALENDAR_SYNC_IPC_CHANNELS.GET_SOURCE, async (_, id: string) => {
    return getCalendarSource(id)
  })

  ipcMain.handle(CALENDAR_SYNC_IPC_CHANNELS.CREATE_SOURCE, async (_, input) => {
    return createCalendarSource(input)
  })

  ipcMain.handle(CALENDAR_SYNC_IPC_CHANNELS.UPDATE_SOURCE, async (_, id: string, patch) => {
    return updateCalendarSource(id, patch)
  })

  ipcMain.handle(CALENDAR_SYNC_IPC_CHANNELS.DELETE_SOURCE, async (_, id: string) => {
    return deleteCalendarSource(id)
  })

  ipcMain.handle(CALENDAR_SYNC_IPC_CHANNELS.SYNC_SOURCE, async (_, sourceId: string) => {
    return syncCalendarSource(sourceId)
  })

  ipcMain.handle(CALENDAR_SYNC_IPC_CHANNELS.SYNC_ALL, async () => {
    return syncAllCalendarSources()
  })

  ipcMain.handle(CALENDAR_SYNC_IPC_CHANNELS.RESOLVE_CONFLICT, async (_, eventId: string, strategy: string) => {
    return resolveSyncConflict(eventId, strategy as 'use-external' | 'use-local' | 'merge' | 'manual')
  })

  ipcMain.handle(CALENDAR_SYNC_IPC_CHANNELS.GET_LAST_SYNC, async (_, sourceId: string) => {
    return getLastSyncTime(sourceId)
  })

  // EventKit 桥接（macOS 系统日历）
  ipcMain.handle(CALENDAR_SYNC_IPC_CHANNELS.CHECK_PERMISSION, async () => {
    return checkCalendarPermission()
  })

  ipcMain.handle(CALENDAR_SYNC_IPC_CHANNELS.REQUEST_PERMISSION, async () => {
    return requestCalendarPermission()
  })

  ipcMain.handle(CALENDAR_SYNC_IPC_CHANNELS.READ_SYSTEM_CALENDAR, async (_, options) => {
    return readSystemCalendar(options)
  })

  ipcMain.handle(CALENDAR_SYNC_IPC_CHANNELS.SYNC_FROM_SYSTEM, async (_, options) => {
    return syncSystemCalendarToGravitas(options)
  })

  // ============================================
  // 3. 项目管理
  // ============================================

  // 项目 CRUD
  ipcMain.handle(PROJECT_CHAIN_IPC.GET, (_, projectId: string) => getProjectChain(projectId))
  ipcMain.handle(PROJECT_CHAIN_IPC.APPLY, (_, projectId: string, revision: number, command: import('@gravitas/shared').ProjectChainCommand) => updateProjectChain(projectId, revision, command))
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_PROJECTS, async () => {
    return listProjects()
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.GET_PROJECT, async (_, id: string) => {
    return getProject(id)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.CREATE_PROJECT, async (_, input) => {
    return createProject(input)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.UPDATE_PROJECT, async (_, id: string, patch) => {
    return updateProject(id, patch)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.DELETE_PROJECT, async (_, id: string) => {
    return deleteProject(id)
  })

  // 任务 CRUD
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_TASKS, async (_, projectId: string, filter) => {
    return listTasks(projectId, filter)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.GET_TASK, async (_, id: string) => {
    return getTask(id)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.CREATE_TASK, async (_, projectId: string, input) => {
    return createTask(projectId, input)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.CREATE_SUB_TASK, async (_, parentId: string, input) => {
    return createSubTask(parentId, input)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_SUB_TASKS, async (_, parentId: string) => {
    return listSubTasks(parentId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.CREATE_EXECUTION_SUB_TASK, async (_, taskId: string, input) => {
    return createExecutionSubTask(taskId, input)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_EXECUTION_SUB_TASKS, async (_, taskId: string) => {
    return listExecutionSubTasks(taskId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.UPDATE_EXECUTION_SUB_TASK, async (_, id: string, patch) => {
    return updateExecutionSubTask(id, patch)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.DELETE_EXECUTION_SUB_TASK, async (_, id: string) => {
    return deleteExecutionSubTask(id)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_DINGTALK_TODO_RETRIES, async (_, projectId: string) => {
    return listDingTalkTodoRetries(projectId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.RETRY_DINGTALK_TODO, async (_, eventId: string) => {
    return retryDingTalkTodo(eventId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.DISMISS_OUTBOX_EVENT, async (_, eventId: string) => {
    const { markOutboxEvent } = await import('./project-sqlite-store')
    return markOutboxEvent(eventId, 'completed')
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.UPDATE_TASK, async (_, id: string, patch) => {
    return updateTask(id, patch)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.DELETE_TASK, async (_, id: string) => {
    return deleteTask(id)
  })

  // 任务草稿
  ipcMain.handle(PROJECT_IPC_CHANNELS.CREATE_TASK_DRAFT, async (_, projectId: string, input) => {
    return createTaskDraft(projectId, input)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.CONFIRM_TASK_DRAFT, async (_, id: string) => {
    return confirmTaskDraft(id)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.REJECT_TASK_DRAFT, async (_, id: string) => {
    return rejectTaskDraft(id)
  })

  // 会议纪要
  ipcMain.handle(PROJECT_IPC_CHANNELS.IMPORT_MEETING_NOTE, async (_, projectId: string, input) => {
    return importMeetingNote(projectId, input)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_MEETING_NOTES, async (_, projectId: string) => {
    return listMeetingNotes(projectId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.GET_MEETING_NOTE, async (_, id: string) => {
    return getMeetingNote(id)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.IMPORT_AND_EXTRACT, async (_, projectId: string, title: string, content: string) => {
    // 获取第一个可用渠道作为 LLM 调用器
    const channels = listChannels()
    const channel = channels.find((c) => c.enabled)
    if (!channel) {
      throw new Error('没有可用的 AI 渠道，请先配置渠道')
    }
    const modelId = channel.models.find((m) => m.enabled)?.id ?? channel.models[0]?.id
    if (!modelId) {
      throw new Error('渠道没有配置模型')
    }
    const apiKey = decryptApiKey(channel.id)
    const { importMeetingNoteAndExtractTasks } = await import('./project-service')
    const llmCaller = createLlmCaller({
      provider: channel.provider,
      baseUrl: channel.baseUrl,
      apiKey,
      modelId,
    })
    return importMeetingNoteAndExtractTasks(projectId, { title, rawContent: content }, llmCaller)
  })

  // 钉钉文档自动拉取 → 任务提取
  ipcMain.handle(PROJECT_IPC_CHANNELS.FETCH_DINGTALK_DOC, async (_, projectId: string, docUrl: string) => {
    const channels = listChannels()
    const channel = channels.find((c) => c.enabled)
    if (!channel) {
      throw new Error('没有可用的 AI 渠道，请先配置渠道')
    }
    const modelId = channel.models.find((m) => m.enabled)?.id ?? channel.models[0]?.id
    if (!modelId) {
      throw new Error('渠道没有配置模型')
    }
    const apiKey = decryptApiKey(channel.id)
    const llmCaller = createLlmCaller({
      provider: channel.provider,
      baseUrl: channel.baseUrl,
      apiKey,
      modelId,
    })
    const { importDingTalkDocAndExtractTasks } = await import('./project-service')
    return importDingTalkDocAndExtractTasks(projectId, docUrl, llmCaller)
  })

  // 飞书文档自动拉取 → 任务提取
  ipcMain.handle(PROJECT_IPC_CHANNELS.FETCH_FEISHU_DOC, async (_, projectId: string, docUrl: string) => {
    const channels = listChannels()
    const channel = channels.find((c) => c.enabled)
    if (!channel) {
      throw new Error('没有可用的 AI 渠道，请先配置渠道')
    }
    const modelId = channel.models.find((m) => m.enabled)?.id ?? channel.models[0]?.id
    if (!modelId) {
      throw new Error('渠道没有配置模型')
    }
    const apiKey = decryptApiKey(channel.id)
    const llmCaller = createLlmCaller({
      provider: channel.provider,
      baseUrl: channel.baseUrl,
      apiKey,
      modelId,
    })
    const { importFeishuDocAndExtractTasks } = await import('./project-service')
    return importFeishuDocAndExtractTasks(projectId, docUrl, llmCaller)
  })

  // Brief 回执：按项目查询
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_BRIEF_RECEIPTS, async (_, projectId: string) => {
    const { listBriefReceiptsByProject } = await import('./project-sqlite-store')
    return listBriefReceiptsByProject(projectId)
  })

  // 钉钉连通性自检
  ipcMain.handle(PROJECT_IPC_CHANNELS.TEST_DINGTALK_CONNECTION, async (_, sendTestMessage?: boolean) => {
    const { testDingTalkConnection } = await import('./dingtalk-connectivity')
    return testDingTalkConnection({ sendTestMessage })
  })

  // 飞书连通性自检
  ipcMain.handle(PROJECT_IPC_CHANNELS.TEST_FEISHU_CONNECTION, async () => {
    const { testFeishuConnection } = await import('./dingtalk-connectivity')
    return testFeishuConnection()
  })

  // Brief 回执：按任务查询
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_BRIEF_RECEIPTS_BY_TASK, async (_, taskId: string) => {
    const { listBriefReceiptsByTask } = await import('./project-sqlite-store')
    return listBriefReceiptsByTask(taskId)
  })

  // Brief：手动触发/补发核心任务回执
  ipcMain.handle(PROJECT_IPC_CHANNELS.SEND_BRIEF, async (_, taskId: string) => {
    const { getTask } = await import('./project-service')
    const { createBriefForTask } = await import('./brief-service')
    const { getBriefCallbackBaseUrl } = await import('./brief-callback-server')
    const task = await getTask(taskId)
    if (!task) throw new Error('任务不存在')
    return createBriefForTask(task, undefined, getBriefCallbackBaseUrl())
  })

  // 看板与进度
  ipcMain.handle(PROJECT_IPC_CHANNELS.GET_KANBAN_BOARD, async (_, projectId: string) => {
    return getKanbanBoard(projectId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.GET_PROJECT_PROGRESS, async (_, projectId: string) => {
    return getProjectProgress(projectId)
  })
  // 任务状态定义（State 分组）
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_TASK_STATUSES, async (_, projectId: string) => {
    return listTaskStatuses(projectId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.CREATE_TASK_STATUS, async (_, projectId: string, input) => {
    return createTaskStatus(projectId, input)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.UPDATE_TASK_STATUS, async (_, projectId: string, statusId: string, patch) => {
    return updateTaskStatusDef(projectId, statusId, patch)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.DELETE_TASK_STATUS, async (_, projectId: string, statusId: string, migrateToStatusId: string) => {
    return deleteTaskStatus(projectId, statusId, migrateToStatusId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.REORDER_TASK_STATUSES, async (_, projectId: string, orderedIds: string[]) => {
    return reorderTaskStatuses(projectId, orderedIds)
  })
  // 任务拖拽排序（一次拖拽可同时改状态与位置）
  ipcMain.handle(PROJECT_IPC_CHANNELS.REORDER_TASK, async (_, id: string, input) => {
    return reorderTask(id, input)
  })
  // 任务级 token 配额：查询任务历次执行会话的累计消耗（配额刹车依据）
  ipcMain.handle(PROJECT_IPC_CHANNELS.GET_TASK_TOKEN_USAGE, async (_, taskId: string) => {
    const { listAgentExecutionsByEntity } = await import('./project-sqlite-store')
    const { getCostMiniLedger } = await import('./token-usage-service')
    const executions = listAgentExecutionsByEntity('task', taskId)
    let totalTokens = 0
    let totalCostUsd = 0
    let activeSessionTokens = 0
    const sessions: Array<{ sessionId: string; status: string; tokens: number; costUsd: number; startedAt: number }> = []
    for (const execution of executions) {
      if (!execution.sessionId || execution.sessionId.startsWith('workflow:')) continue
      const ledger = getCostMiniLedger({ sessionId: execution.sessionId })
      totalTokens += ledger.totalTokens
      totalCostUsd += ledger.totalCostUsd
      if (execution.status === 'queued' || execution.status === 'running') {
        activeSessionTokens += ledger.totalTokens
      }
      sessions.push({
        sessionId: execution.sessionId,
        status: execution.status,
        tokens: ledger.totalTokens,
        costUsd: ledger.totalCostUsd,
        startedAt: execution.startedAt,
      })
    }
    return { taskId, totalTokens, totalCostUsd, activeSessionTokens, sessions }
  })
  // 项目级 AI 成本聚合：本项目所有 agent 执行的 token/费用（按员工分组 + 超限任务清单）
  ipcMain.handle(PROJECT_IPC_CHANNELS.GET_PROJECT_AI_COST, async (_, projectId: string) => {
    const { listAgentExecutionsByEntity, listTasks, getAgentEmployee } = await import('./project-sqlite-store')
    const { getCostMiniLedger } = await import('./token-usage-service')
    const tasks = listTasks(projectId, { includeSubTasks: true, includeDrafts: true })
    const agentNames = new Map<string, string>()
    const byAgent = new Map<string, { agentId: string; agentName: string; tokens: number; costUsd: number; taskCount: number }>()
    let totalTokens = 0
    let totalCostUsd = 0
    const overBudgetTasks: Array<{ taskId: string; title: string; budget: number; used: number }> = []
    for (const task of tasks) {
      for (const execution of listAgentExecutionsByEntity('task', task.id)) {
        if (!execution.sessionId || execution.sessionId.startsWith('workflow:')) continue
        const ledger = getCostMiniLedger({ sessionId: execution.sessionId })
        if (ledger.totalTokens === 0) continue
        totalTokens += ledger.totalTokens
        totalCostUsd += ledger.totalCostUsd
        const name = agentNames.get(execution.agentId) ?? getAgentEmployee(execution.agentId)?.name ?? `员工-${execution.agentId.slice(0, 6)}`
        agentNames.set(execution.agentId, name)
        const bucket = byAgent.get(execution.agentId) ?? { agentId: execution.agentId, agentName: name, tokens: 0, costUsd: 0, taskCount: 0 }
        bucket.tokens += ledger.totalTokens
        bucket.costUsd += ledger.totalCostUsd
        bucket.taskCount += 1
        byAgent.set(execution.agentId, bucket)
      }
      // 配额超限清单：有预算且最近执行会话消耗超限
      if (task.tokenBudget && task.tokenBudget > 0) {
        const executions = listAgentExecutionsByEntity('task', task.id)
        const latestWithSession = [...executions].reverse().find((e) => e.sessionId && !e.sessionId.startsWith('workflow:'))
        if (latestWithSession?.sessionId) {
          const used = getCostMiniLedger({ sessionId: latestWithSession.sessionId }).totalTokens
          if (used > task.tokenBudget) {
            overBudgetTasks.push({ taskId: task.id, title: task.title, budget: task.tokenBudget, used })
          }
        }
      }
    }
    return {
      projectId,
      totalTokens,
      totalCostUsd,
      overBudgetTasks,
      byAgent: [...byAgent.values()].sort((a, b) => b.tokens - a.tokens),
    }
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_TASK_DEPENDENCIES, async (_, projectId: string) => {
    return listTaskDependencies(projectId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.CREATE_TASK_DEPENDENCY, async (_, taskId: string, dependsOnTaskId: string, type?: string) => {
    return createTaskDependency(taskId, dependsOnTaskId, type as Parameters<typeof createTaskDependency>[2])
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.DELETE_TASK_DEPENDENCY, async (_, id: string) => {
    return deleteTaskDependency(id)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_TASK_BLOCKERS, async (_, projectId: string) => {
    return listTaskBlockers(projectId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_PROJECT_WORK_ITEMS, async (_, projectId: string) => {
    return listProjectWorkItems(projectId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_MY_WORK, async (_, assigneeUserId: string) => {
    return listMyWork(assigneeUserId)
  })

  // 日程视图：跨项目轻量任务（有 dueDate 且未完成）
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_ALL_PROJECT_TASKS_LITE, async () => {
    const { listAllProjectTasksLite } = await import('./project-service')
    return listAllProjectTasksLite()
  })

  // PH2-⑤：我发起/指派的任务
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_TASKS_CREATED_BY, async (_, creatorUserId: string) => {
    const { listTasksCreatedBy } = await import('./project-service')
    return listTasksCreatedBy(creatorUserId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_PROJECT_ALERTS, async (_, projectId: string) => {
    return listProjectAlerts(projectId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_PROJECT_ACTIVITIES, async (_, projectId: string) => {
    return listProjectActivities(projectId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.GENERATE_PROJECT_SUMMARY, async (_, projectId: string) => {
    return generateProjectSummary(projectId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_PROJECT_TEMPLATES, async () => listProjectTemplates())
  ipcMain.handle(PROJECT_IPC_CHANNELS.CREATE_PROJECT_TEMPLATE, async (_, projectId: string, name: string, description?: string) => createProjectTemplateFromProject(projectId, name, description))
  ipcMain.handle(PROJECT_IPC_CHANNELS.APPLY_PROJECT_TEMPLATE, async (_, templateId: string, projectName: string) => applyProjectTemplate(templateId, projectName))
  ipcMain.handle(PROJECT_IPC_CHANNELS.SEND_PROJECT_SUMMARY_DINGTALK, async (_, projectId: string) => sendProjectSummaryToDingTalk(projectId))
  ipcMain.handle(PROJECT_IPC_CHANNELS.SEND_PROJECT_SUMMARY_FEISHU, async (_, projectId: string, chatId: string) => sendProjectSummaryToFeishu(projectId, chatId))

  // 用户映射
  ipcMain.handle(PROJECT_IPC_CHANNELS.SAVE_USER_MAPPING, async (_, input) => {
    return saveUserMapping(input)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.GET_USER_MAPPING, async (_, paaUserId: string) => {
    return getUserMapping(paaUserId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_USER_MAPPINGS, async () => {
    return listUserMappings()
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.DELETE_USER_MAPPING, async (_, paaUserId: string) => {
    return deleteUserMapping(paaUserId)
  })

  // 外部同步
  ipcMain.handle(PROJECT_IPC_CHANNELS.SYNC_TASK, async (_, taskId: string, platform: 'feishu' | 'dingtalk') => {
    return syncTaskById(taskId, platform)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.GET_SYNC_STATUS, async (_, taskId: string, platform: 'feishu' | 'dingtalk') => {
    const localInfo = await getTaskExternalSyncInfo(taskId)
    const externalStatus = await getSyncStatusById(taskId, platform)
    return { localInfo, externalStatus }
  })

  // 风险评估
  ipcMain.handle(PROJECT_IPC_CHANNELS.ASSESS_TASK_RISK, async (_, taskId: string) => {
    // 获取第一个可用渠道作为 LLM 调用器
    const riskChannels = listChannels()
    const riskEnabledChannel = riskChannels.find((c) => c.enabled)
    if (!riskEnabledChannel) {
      throw new Error('没有可用的 AI 渠道')
    }

    const modelId = riskEnabledChannel.models.find((m) => m.enabled)?.id ?? riskEnabledChannel.models[0]?.id
    if (!modelId) {
      throw new Error('渠道没有配置模型')
    }
    const apiKey = decryptApiKey(riskEnabledChannel.id)

    const llmCaller = createLlmCaller({
      provider: riskEnabledChannel.provider,
      baseUrl: riskEnabledChannel.baseUrl,
      apiKey,
      modelId,
      maxTokens: 1000,
    })

    return assessTaskRisk(taskId, llmCaller)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.SAVE_COMPLETION_NOTES, async (_, taskId: string, notes: string) => {
    return saveCompletionNotes(taskId, notes)
  })

  // ===== 外部状态轮询 =====
  ipcMain.handle(PROJECT_IPC_CHANNELS.POLL_START, async (_, projectId: string, platform: 'feishu' | 'dingtalk', intervalMs: number = 30000) => {
    const key = `${projectId}:${platform}`

    // 如果已有轮询，先停止
    const existingStop = pollingTimers.get(key)
    if (existingStop) {
      existingStop()
      pollingTimers.delete(key)
    }

    // 创建 Provider（实际 Provider 会在初始化时注册到 project-polling-service）
    const provider = getPollingProvider(platform)
    if (!provider) {
      throw new Error(`${platform} 轮询 Provider 未注册`)
    }

    // 获取 LLM Caller 用于自动风险评估
    const riskChannels = listChannels()
    const riskEnabledChannel = riskChannels.find((c) => c.enabled)
    let llmCaller: import('./project-agent-service').LLMCaller | undefined

    if (riskEnabledChannel) {
      const riskModelId = riskEnabledChannel.models.find((m) => m.enabled)?.id ?? riskEnabledChannel.models[0]?.id
      if (riskModelId) {
        const riskApiKey = decryptApiKey(riskEnabledChannel.id)
        llmCaller = createLlmCaller({
          provider: riskEnabledChannel.provider,
          baseUrl: riskEnabledChannel.baseUrl,
          apiKey: riskApiKey,
          modelId: riskModelId,
          maxTokens: 1000,
        })
      }
    }

    const stop = createPollingTimer(
      projectId,
      platform,
      provider,
      intervalMs,
      { autoAssessRisk: true, llmCaller }
    )

    pollingTimers.set(key, stop)
    console.log(`[ProjectPolling] 已启动 ${key} 轮询，间隔 ${intervalMs}ms`)
    return { started: true, key }
  })

  ipcMain.handle(PROJECT_IPC_CHANNELS.POLL_STOP, async (_, projectId: string, platform: 'feishu' | 'dingtalk') => {
    const key = `${projectId}:${platform}`
    const stop = pollingTimers.get(key)
    if (stop) {
      stop()
      pollingTimers.delete(key)
      console.log(`[ProjectPolling] 已停止 ${key} 轮询`)
      return { stopped: true, key }
    }
    return { stopped: false, key, error: '未找到轮询' }
  })

  // ===== 项目风险报告 =====
  ipcMain.handle(PROJECT_IPC_CHANNELS.GENERATE_RISK_REPORT, async (_, projectId: string) => {
    const riskChannels = listChannels()
    const riskEnabledChannel = riskChannels.find((c) => c.enabled)
    if (!riskEnabledChannel) {
      throw new Error('没有可用的 AI 渠道')
    }

    const modelId = riskEnabledChannel.models.find((m) => m.enabled)?.id ?? riskEnabledChannel.models[0]?.id
    if (!modelId) {
      throw new Error('渠道没有配置模型')
    }
    const apiKey = decryptApiKey(riskEnabledChannel.id)

    const llmCaller = createLlmCaller({
      provider: riskEnabledChannel.provider,
      baseUrl: riskEnabledChannel.baseUrl,
      apiKey,
      modelId,
      maxTokens: 1500,
    })

    return generateProjectRiskReport(projectId, llmCaller)
  })

  // 外部通讯录搜索（负责人选择器）
  ipcMain.handle(PROJECT_IPC_CHANNELS.SEARCH_CONTACTS_ALL, async (_: unknown, keyword?: string) => {
    const { searchContactsAll } = await import('./contact-search-service')
    return searchContactsAll(keyword ?? '')
  })

  // ===== 成员同步（PH1-A） =====
  ipcMain.handle(PROJECT_IPC_CHANNELS.SYNC_MEMBERS_ALL, async () => {
    const { syncAllMembers } = await import('./member-sync-service')
    return syncAllMembers()
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.SYNC_MEMBERS_FEISHU, async () => {
    const { syncMembersFromFeishu } = await import('./member-sync-service')
    return syncMembersFromFeishu()
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.SYNC_MEMBERS_DINGTALK, async () => {
    const { syncMembersFromDingtalk } = await import('./member-sync-service')
    return syncMembersFromDingtalk()
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_MEMBERS, (_: unknown, filter?: { kind?: string; q?: string; activeOnly?: boolean }) => {
    const { listMembers } = require('./project-sqlite-store')
    return listMembers(filter ?? {})
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.GET_MEMBER, (_: unknown, memberId: string) => {
    const { getMember } = require('./project-sqlite-store')
    return getMember(memberId)
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.ENSURE_MEMBER_BY_NAME, (_: unknown, displayName: string) => {
    const { ensureMemberByName } = require('./project-sqlite-store')
    return ensureMemberByName(displayName)
  })

  // ===== 成员目录聚合（PH1-B） =====
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_MEMBER_DIRECTORY, (_: unknown, filter?: { kind?: string; q?: string; activeOnly?: boolean }) => {
    const { listMemberDirectory } = require('./member-directory-service')
    return listMemberDirectory(filter ?? {})
  })
  ipcMain.handle(PROJECT_IPC_CHANNELS.COUNT_MEMBER_DIRECTORY, () => {
    const { countMemberDirectory } = require('./member-directory-service')
    return countMemberDirectory()
  })

  // ===== AI 员工（Agent Employee）=====
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.LIST_EMPLOYEES, () => listAgentEmployees())
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.GET_EMPLOYEE, (_, id: string) => getAgentEmployee(id))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.CREATE_EMPLOYEE, (_, input) => createAgentEmployee(input))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.UPDATE_EMPLOYEE, (_, id: string, patch) => updateAgentEmployee(id, patch))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.DELETE_EMPLOYEE, (_, id: string) => deleteAgentEmployee(id))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.LIST_EXECUTIONS_BY_ENTITY, (_, entityType: 'task' | 'subTask', entityId: string) => listAgentExecutionsByEntity(entityType, entityId))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.LIST_EXECUTIONS_BY_AGENT, (_, agentId: string, limit?: number) => listAgentExecutionsByAgent(agentId, limit ?? 50))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.CANCEL_EXECUTION, (_, executionId: string) => cancelAgentExecution(executionId))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.LIST_CAPABILITY_VERSIONS, (_, agentId: string) => listAgentEmployeeCapabilityVersions(agentId))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.LIST_LEARNING_SAMPLES, (_, agentId: string) => listAgentEmployeeLearningSamples(agentId))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.EXCLUDE_LEARNING_SAMPLE, (_, sampleId: string) => excludeAgentEmployeeLearningSample(sampleId))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.REVIEW_LEARNING_SAMPLE, (_, sampleId: string, evidenceSummary: string) => reviewAgentEmployeeLearningSample(sampleId, evidenceSummary))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.GET_CAPABILITY_OBSERVATIONS, (_, agentId: string) => getAgentEmployeeCapabilityObservations(agentId))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.ROLLBACK_CAPABILITY_VERSION, (_, agentId: string, versionId: string, reason: string) => rollbackAgentEmployeeCapabilityVersion(agentId, versionId, reason))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.LIST_CAPABILITY_ROLLBACK_AUDITS, (_, agentId: string) => listAgentEmployeeCapabilityRollbackAudits(agentId))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.RUN_CAPABILITY_EVALUATION, (_, input: import('@gravitas/shared').RunAgentEmployeeCapabilityEvaluationInput) => runEmployeeCapabilityEvaluation(input))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.GET_CAPABILITY_HEALTH, (_, agentId: string, windowDays?: number) => getAgentEmployeeCapabilityHealth(agentId, windowDays))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.LIST_CAPABILITY_CANARY, (_, agentId: string) => listEmployeeCanaryConfigs().filter((config) => config.agentId === agentId))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.ENABLE_CAPABILITY_CANARY, (_, input: import('@gravitas/shared').AgentEmployeeCanaryConfigResult) => enableEmployeeCanary(input))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.DISABLE_CAPABILITY_CANARY, (_, agentId: string, scope: 'role' | 'workspace', reason: string) => reason ? pauseEmployeeCanary(agentId, scope, reason) : disableEmployeeCanary(agentId, scope))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.GET_CAPABILITY_DEPENDENCY_GRAPH, (_, agentId: string) => getAgentEmployeeCapabilityDependencyGraph(agentId))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.PREVIEW_CAPABILITY_CONFLICTS, (_, input: { roleContent?: string; workspaceContent?: string }) => detectCapabilityConflicts(input))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.GET_GOVERNANCE_POLICY, () => getGovernancePolicy())
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.UPDATE_GOVERNANCE_POLICY, (_, patch: Partial<import('@gravitas/shared').EmployeeCapabilityGovernancePolicyResult>) => updateGovernancePolicy(patch))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.LIST_GOVERNANCE_AUDITS, () => listGovernanceAudits())
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.PREVIEW_SAMPLE_RETENTION, (_, agentId: string, retentionDays: number | null) => previewAgentEmployeeLearningSampleRetention(agentId, retentionDays))
  // 删除为不可逆操作：调用方必须先展示预览并取得用户确认。
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.DELETE_LEARNING_SAMPLES, (_, ids: string[]) => deleteAgentEmployeeLearningSamples(ids))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.GET_EVOLUTION_LEDGER, (_, agentIds?: string[], windowDays?: number) => buildEmployeeCapabilityReviewReport({ agentIds, windowDays }))
  // 导出默认脱敏；导入只校验并返回摘要，不激活任何内容。
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.EXPORT_EVOLUTION_PACKAGE, (_, agentIds?: string[]) => exportEvolutionPackage({ agentIds }))
  ipcMain.handle(AGENT_EMPLOYEE_IPC_CHANNELS.VALIDATE_EVOLUTION_PACKAGE, (_, input: unknown) => {
    const result = validateEvolutionPackage(input)
    return result.ok ? { ok: true, summary: summarizeEvolutionPackageForReview(result.package) } : result
  })

  // ===== 初始化 Todo Provider =====
  initProjectTodoProviders()

  // 注册 AI 员工 TodoProvider（agent）+ 启动心跳扫描
  registerAgentEmployeeProvider()
  // 本地自动同步：任务创建/状态变更 → 钉钉待办推送/回写（替代原 NocoBase 插件 hook）
  registerProjectAutoSync()

  // 设置变更时重新初始化 Provider，避免必须重启应用
  onSettingsChange((_, updates) => {
    if (updates.feishuTodo !== undefined || updates.dingtalkTodo !== undefined) {
      console.log('[ProjectTodoProviders] 检测到外部平台配置变更，重新初始化 Provider')
      initProjectTodoProviders()
    }
  })

  // ============================================
  // 营销能力包 — 共享素材 creative
  // ============================================
  ipcMain.handle(CREATIVE_IPC_CHANNELS.LIST_PROJECTS, async () => {
    await ensureMarketingReady()
    return marketingService.listCreativeProjects()
  })
  ipcMain.handle(CREATIVE_IPC_CHANNELS.CREATE_PROJECT, async (_: unknown, input) => {
    await ensureMarketingReady()
    return marketingService.createCreativeProject(input)
  })
  ipcMain.handle(CREATIVE_IPC_CHANNELS.LIST_ASSETS, async () => {
    await ensureMarketingReady()
    return marketingService.listCreativeAssets()
  })
  ipcMain.handle(CREATIVE_IPC_CHANNELS.CREATE_TASK, async (_: unknown, input) => {
    await ensureMarketingReady()
    return marketingService.createCreativeAsset(input)
  })
  ipcMain.handle(CREATIVE_IPC_CHANNELS.DELETE_ASSET, async (_: unknown, id: string) => {
    await ensureMarketingReady()
    return marketingService.deleteCreativeAsset(id)
  })

  // ===== 视频生成（共享素材）=====
  ipcMain.handle(CREATIVE_IPC_CHANNELS.GEN_STORYBOARD, (_: unknown, input) => {
    return creativeVideoService.generateStoryboard(input)
  })
  ipcMain.handle(CREATIVE_IPC_CHANNELS.RUN_PIPELINE, async (_: unknown, options) => {
    return creativeVideoService.runPipeline(options)
  })
  ipcMain.handle(CREATIVE_IPC_CHANNELS.PROBE_ASSET, async (_: unknown, videoPath: string) => {
    return creativeVideoService.probeAsset(videoPath)
  })
  ipcMain.handle(CREATIVE_IPC_CHANNELS.CHECK_CREDENTIAL, (_: unknown, engine: 'seedance' | 'minimax-h3') => {
    return creativeVideoService.checkCredential(engine)
  })

  // ============================================
  // 营销能力包 — 达人 influencer
  // ============================================
  ipcMain.handle(INFLUENCER_IPC_CHANNELS.LIST_TALENTS, async () => {
    await ensureMarketingReady()
    return marketingService.listInfluencerTalents()
  })
  ipcMain.handle(INFLUENCER_IPC_CHANNELS.GET_TALENT, async (_: unknown, id: string) => {
    await ensureMarketingReady()
    return marketingService.getInfluencerTalent(id)
  })
  ipcMain.handle(INFLUENCER_IPC_CHANNELS.CREATE_TALENT, async (_: unknown, input) => {
    await ensureMarketingReady()
    return marketingService.createInfluencerTalent(input)
  })
  ipcMain.handle(INFLUENCER_IPC_CHANNELS.UPDATE_TALENT, async (_: unknown, id: string, patch) => {
    await ensureMarketingReady()
    return marketingService.updateInfluencerTalent(id, patch)
  })
  ipcMain.handle(INFLUENCER_IPC_CHANNELS.DELETE_TALENT, async (_: unknown, id: string) => {
    await ensureMarketingReady()
    return marketingService.deleteInfluencerTalent(id)
  })
  ipcMain.handle(INFLUENCER_IPC_CHANNELS.LIST_BRIEFS, async () => {
    await ensureMarketingReady()
    return marketingService.listInfluencerBriefs()
  })
  ipcMain.handle(INFLUENCER_IPC_CHANNELS.CREATE_BRIEF, async (_: unknown, input) => {
    await ensureMarketingReady()
    return marketingService.createInfluencerBrief(input)
  })
  ipcMain.handle(INFLUENCER_IPC_CHANNELS.LIST_DRAFTS, async () => {
    await ensureMarketingReady()
    return marketingService.listInfluencerDrafts()
  })
  ipcMain.handle(INFLUENCER_IPC_CHANNELS.GET_DRAFT, async (_: unknown, id: string) => {
    await ensureMarketingReady()
    return marketingService.getInfluencerDraft(id)
  })
  ipcMain.handle(INFLUENCER_IPC_CHANNELS.CREATE_DRAFT, async (_: unknown, input) => {
    await ensureMarketingReady()
    return marketingService.createInfluencerDraft(input)
  })
  ipcMain.handle(INFLUENCER_IPC_CHANNELS.UPDATE_DRAFT, async (_: unknown, id: string, patch) => {
    await ensureMarketingReady()
    return marketingService.updateInfluencerDraft(id, patch)
  })
  ipcMain.handle(INFLUENCER_IPC_CHANNELS.DELETE_DRAFT, async (_: unknown, id: string) => {
    await ensureMarketingReady()
    return marketingService.deleteInfluencerDraft(id)
  })

  // ============================================
  // 营销能力包 — 广告投放 paid-media
  // ============================================
  ipcMain.handle(PAID_MEDIA_IPC_CHANNELS.LIST_CAMPAIGNS, async () => {
    await ensureMarketingReady()
    return marketingService.listPaidCampaigns()
  })
  ipcMain.handle(PAID_MEDIA_IPC_CHANNELS.GET_CAMPAIGN, async (_: unknown, id: string) => {
    await ensureMarketingReady()
    return marketingService.getPaidCampaign(id)
  })
  ipcMain.handle(PAID_MEDIA_IPC_CHANNELS.CREATE_CAMPAIGN, async (_: unknown, input) => {
    await ensureMarketingReady()
    return marketingService.createPaidCampaign(input)
  })
  ipcMain.handle(PAID_MEDIA_IPC_CHANNELS.UPDATE_CAMPAIGN, async (_: unknown, id: string, patch) => {
    await ensureMarketingReady()
    return marketingService.updatePaidCampaign(id, patch)
  })
  ipcMain.handle(PAID_MEDIA_IPC_CHANNELS.DELETE_CAMPAIGN, async (_: unknown, id: string) => {
    await ensureMarketingReady()
    return marketingService.deletePaidCampaign(id)
  })
  ipcMain.handle(PAID_MEDIA_IPC_CHANNELS.LIST_CONTROL_ACTIONS, async () => {
    await ensureMarketingReady()
    return marketingService.listPaidControlActions()
  })
  ipcMain.handle(PAID_MEDIA_IPC_CHANNELS.CREATE_CONTROL_ACTION, async (_: unknown, input) => {
    await ensureMarketingReady()
    return marketingService.createPaidControlAction(input)
  })
  ipcMain.handle(PAID_MEDIA_IPC_CHANNELS.UPDATE_CONTROL_ACTION, async (_: unknown, id: string, patch) => {
    await ensureMarketingReady()
    return marketingService.updatePaidControlAction(id, patch)
  })
  ipcMain.handle(PAID_MEDIA_IPC_CHANNELS.LIST_RULES, async () => {
    await ensureMarketingReady()
    return marketingService.listPaidRules()
  })
  ipcMain.handle(PAID_MEDIA_IPC_CHANNELS.CREATE_RULE, async (_: unknown, input) => {
    await ensureMarketingReady()
    return marketingService.createPaidRule(input)
  })
  ipcMain.handle(PAID_MEDIA_IPC_CHANNELS.UPDATE_RULE, async (_: unknown, id: string, patch) => {
    await ensureMarketingReady()
    return marketingService.updatePaidRule(id, patch)
  })

  // ============================================
  // 新媒体运营本地工作台（无外部平台副作用）
  // ============================================
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.LIST_DRAFTS, async () => {
    const { listContentDrafts } = await import('./new-media/content-operations')
    return listContentDrafts()
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.CREATE_DRAFT, async (_: unknown, sourceText: string, platforms: import('@gravitas/shared').NewMediaPlatform[]) => {
    const { createContentDraft } = await import('./new-media/content-operations')
    return createContentDraft(sourceText, platforms)
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.LIST_PUBLICATION_JOBS, async () => {
    const { listPublicationJobs } = await import('./new-media/content-operations')
    return listPublicationJobs()
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.SCHEDULE_PUBLICATION, async (_: unknown, input: { draftId: string; platform: import('@gravitas/shared').NewMediaPlatform; accountId: string; scheduledAt: number }) => {
    const { schedulePublication } = await import('./new-media/content-operations')
    return schedulePublication(input)
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.LIST_ENGAGEMENTS, async () => (await import('./new-media/community-listening')).listEngagements())
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.INGEST_ENGAGEMENT, async (_: unknown, input) => (await import('./new-media/community-listening')).ingestEngagement(input))
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.CREATE_REPLY_DRAFT, async (_: unknown, engagementId: string) => (await import('./new-media/community-listening')).createReplyDraft(engagementId))
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.LIST_LISTENING_QUERIES, async () => (await import('./new-media/community-listening')).listListeningQueries())
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.CREATE_LISTENING_QUERY, async (_: unknown, keywords: string[]) => (await import('./new-media/community-listening')).createListeningQuery(keywords))
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.LIST_MENTIONS, async (_: unknown, queryId?: string) => (await import('./new-media/community-listening')).listMentions(queryId))
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.INGEST_MENTION, async (_: unknown, input) => (await import('./new-media/community-listening')).ingestMention(input))
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.GET_LISTENING_DIGEST, async (_: unknown, queryId: string) => (await import('./new-media/community-listening')).getListeningDigest(queryId))
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.LIST_METRIC_SNAPSHOTS, async () => (await import('./new-media/analytics-trends')).listMetricSnapshots())
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.INGEST_METRIC_SNAPSHOT, async (_: unknown, input) => (await import('./new-media/analytics-trends')).ingestMetricSnapshot(input))
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.GET_SOCIAL_REPORT, async (_: unknown, periodStart: number, periodEnd: number) => (await import('./new-media/analytics-trends')).getSocialReport(periodStart, periodEnd))
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.LIST_TRENDS, async () => (await import('./new-media/analytics-trends')).listTrends())
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.INGEST_TREND, async (_: unknown, input) => (await import('./new-media/analytics-trends')).ingestTrend(input))
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.GET_TREND_OPPORTUNITIES, async (_: unknown, keywords: string[]) => (await import('./new-media/analytics-trends')).getTrendOpportunities(keywords))

  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.LIST_CONTROLLED_ACTIONS, async () => {
    const { listControlledActions } = await import('./new-media/controlled-actions')
    return listControlledActions()
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.REQUEST_CONTROLLED_ACTION, async (_: unknown, input: { kind: 'publish' | 'send-reply'; platform: import('@gravitas/shared').NewMediaPlatform; targetId: string; summary: string }) => {
    const { requestControlledAction } = await import('./new-media/controlled-actions')
    return requestControlledAction(input)
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.APPROVE_CONTROLLED_ACTION, async (_: unknown, actionId: string, approver: string) => {
    const { approveControlledAction } = await import('./new-media/controlled-actions')
    return approveControlledAction(actionId, approver)
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.SIMULATE_CONTROLLED_ACTION, async (_: unknown, actionId: string) => {
    const { simulateControlledAction } = await import('./new-media/controlled-actions')
    return simulateControlledAction(actionId)
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.GET_CONTROLLED_ACTION_AUDIT, async (_: unknown, actionId: string) => {
    const { getControlledActionAudit } = await import('./new-media/controlled-actions')
    return getControlledActionAudit(actionId)
  })

  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.LIST_ACCOUNTS, async () => (await import('./new-media/new-media-account-service')).listNewMediaAccounts())
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.CREATE_ACCOUNT, async (_: unknown, input: { platform: import('@gravitas/shared').NewMediaPlatform; displayName: string }) => {
    if (!input || !['xiaohongshu', 'wechat-official-account'].includes(input.platform) || typeof input.displayName !== 'string') throw new Error('账号参数无效')
    return (await import('./new-media/new-media-account-service')).createNewMediaAccount(input)
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.BEGIN_ACCOUNT_AUTHORIZATION, async (_: unknown, accountId: string) => {
    if (typeof accountId !== 'string' || !accountId) throw new Error('账号 ID 无效')
    return (await import('./new-media/new-media-account-service')).beginNewMediaAccountAuthorization(accountId)
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.VALIDATE_ACCOUNT, async (_: unknown, accountId: string) => {
    if (typeof accountId !== 'string' || !accountId) throw new Error('账号 ID 无效')
    return (await import('./new-media/new-media-account-service')).validateNewMediaAccount(accountId)
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.DISCONNECT_ACCOUNT, async (_: unknown, accountId: string) => {
    if (typeof accountId !== 'string' || !accountId) throw new Error('账号 ID 无效')
    return (await import('./new-media/new-media-account-service')).disconnectNewMediaAccount(accountId)
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.GET_ACCOUNT_AUDIT, async (_: unknown, accountId: string) => {
    if (typeof accountId !== 'string' || !accountId) throw new Error('账号 ID 无效')
    return (await import('./new-media/new-media-account-service')).getNewMediaAccountAudit(accountId)
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.GET_ADAPTER_INFO, async (_: unknown, platform: import('@gravitas/shared').NewMediaPlatform) => {
    if (!['xiaohongshu', 'wechat-official-account'].includes(platform)) throw new Error('平台无效')
    const { adapterInfo } = await import('./new-media/platform-adapter')
    const { getPlatformAdapterRegistry } = await import('./new-media/platform-adapter-registry')
    return adapterInfo(getPlatformAdapterRegistry().get(platform))
  })

  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.LIST_XHS_HANDOFFS, async () => (await import('./new-media/xiaohongshu-handoff')).listXiaohongshuHandoffs())
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.PREPARE_XHS_HANDOFF, async (_: unknown, draftId: string) => {
    if (typeof draftId !== 'string' || !draftId) throw new Error('草稿 ID 无效')
    return (await import('./new-media/xiaohongshu-handoff')).prepareXiaohongshuHandoff(draftId)
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.EXPORT_XHS_HANDOFF, async (event, handoffId: string) => {
    if (typeof handoffId !== 'string' || !handoffId) throw new Error('交接 ID 无效')
    const service = await import('./new-media/xiaohongshu-handoff')
    const handoff = (await service.listXiaohongshuHandoffs()).find((item) => item.id === handoffId)
    if (!handoff) throw new Error('小红书发布交接不存在')
    const owner = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
    const options = {
      title: '导出小红书发布交付包',
      defaultPath: handoff.packageFileName,
      filters: [{ name: 'ZIP 交付包', extensions: ['zip'] }],
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { canceled: true }
    const exported = await service.exportXiaohongshuHandoff(handoffId, result.filePath)
    return { canceled: false, fileName: exported.packageFileName, sha256: exported.packageSha256 }
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.CONFIRM_XHS_PUBLISHED, async (_: unknown, handoffId: string, actor: string) => {
    if (typeof handoffId !== 'string' || !handoffId || typeof actor !== 'string') throw new Error('确认参数无效')
    return (await import('./new-media/xiaohongshu-handoff')).confirmXiaohongshuPublished(handoffId, actor)
  })
  ipcMain.handle(NEW_MEDIA_IPC_CHANNELS.GET_XHS_HANDOFF_AUDIT, async (_: unknown, handoffId: string) => {
    if (typeof handoffId !== 'string' || !handoffId) throw new Error('交接 ID 无效')
    return (await import('./new-media/xiaohongshu-handoff')).getXiaohongshuHandoffAudit(handoffId)
  })
}
