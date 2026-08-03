/**
 * 工作模块 IPC 处理器注册（项目管理 / 日程管家 / 日历同步）
 *
 * 由 ~/LLM/PAA 的 paa-ipc-handlers.ts 中 project / schedule / calendar-sync 三个
 * 子模块的处理器迁移而来，桥接渲染进程 IPC 调用到主进程服务层。
 */

import { ipcMain } from 'electron'
import {
  SCHEDULE_IPC_CHANNELS,
  CALENDAR_SYNC_IPC_CHANNELS,
  PROJECT_IPC_CHANNELS,
} from '@proma/shared'

// ===== 日程管家服务 =====
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
  syncSystemCalendarToPaa,
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
    return syncSystemCalendarToPaa(options)
  })

  // ============================================
  // 3. 项目管理
  // ============================================

  // 项目 CRUD
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

  // ===== 初始化 Todo Provider =====
  initProjectTodoProviders()

  // 本地自动同步：任务创建/状态变更 → 钉钉待办推送/回写（替代原 NocoBase 插件 hook）
  registerProjectAutoSync()

  // 设置变更时重新初始化 Provider，避免必须重启应用
  onSettingsChange((_, updates) => {
    if (updates.feishuTodo !== undefined || updates.dingtalkTodo !== undefined) {
      console.log('[ProjectTodoProviders] 检测到外部平台配置变更，重新初始化 Provider')
      initProjectTodoProviders()
    }
  })
}
