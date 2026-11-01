/** 项目级每日公开网络扫描：配置与历史保存在本机 projects/web-watch。 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { getProject, listTasks } from './project-service'
import { decryptApiKey, listChannels } from './channel-manager'
import { searchWebResults, type WebSearchResultItem } from './agent-runtime/tool-impls/web-search-tool'
import { getSettings } from './settings-service'
import { sendSystemNotification } from './system-notification-service'
import { getAdapter } from '@gravitas/core'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { isProjectWebWatchDue, shouldNotifyFailure, shouldNotifySuccess } from './project-web-watch-policy'
import {
  WEB_WATCH_RUN_RETENTION,
  getProjectWebWatchConfigPath,
  getProjectWebWatchRunsPath,
} from './project-web-watch-store'
import { listProjectWebChangeObservations } from './project-web-change-observations'
import { listWebObservationFeedback } from './project-web-observation-feedback'
import { WEB_OBSERVATION_PROMPT_VERSION, buildWebObservationPrompt, type WebObservationHistoryEntry } from './project-web-observation-prompt'
import { judgeAndRecordWebObservation } from './project-web-change-judgment'
import { enqueueWebChangeObservation } from './project-web-change-observation-delivery'

export interface ProjectWebWatchConfig {
  projectId: string
  enabled: boolean
  topics: string[]
  localTime: string
  lastAttemptAt?: number
  lastSuccessAt?: number
  /** 最近一次成功提醒时间；同一天最多提醒一次。 */
  lastNotifiedAt?: number
  /** 最近一次失败提醒时间；24 小时内最多一次。 */
  lastFailureNotifiedAt?: number
  /** 连续失败次数；达到 3 次后不再弹系统通知，只在项目页显示。 */
  consecutiveFailures?: number
  updatedAt: number
}

export type ProjectWebWatchRunStatus = 'success' | 'failed' | 'skipped'

/** 跳过原因：预算不足时整轮跳过，不产生观察记录（用户 2026-10-31 决定）。 */
export type ProjectWebWatchSkipReason = 'budget_exhausted'

export interface ProjectWebWatchRun {
  id: string
  projectId: string
  startedAt: number
  endedAt: number
  coverageFrom: number
  coverageTo: number
  status: ProjectWebWatchRunStatus
  skipReason?: ProjectWebWatchSkipReason
  queries: string[]
  sources: WebSearchResultItem[]
  newSources: WebSearchResultItem[]
  /** 兼容字段：本次判断的一句话摘要，不再是模型自由文本。 */
  analysis?: string
  /** 本次判断落下的观察记录 id 与最终判定。 */
  observationId?: string
  judgment?: string
  error?: string
}

const POLL_INTERVAL_MS = 60_000
const MAX_TOPICS = 8
const MAX_SOURCES = 30
const DAY_MS = 24 * 60 * 60 * 1000
let timer: ReturnType<typeof setInterval> | undefined
let scanning = false
const activeProjectIds = new Set<string>()

function configPath(projectId: string): string { return getProjectWebWatchConfigPath(projectId) }
function runsPath(projectId: string): string { return getProjectWebWatchRunsPath(projectId) }

export function getProjectWebWatchConfig(projectId: string): ProjectWebWatchConfig {
  return readJsonFileSafe<ProjectWebWatchConfig>(configPath(projectId)) ?? {
    projectId, enabled: false, topics: [], localTime: '09:00', updatedAt: Date.now(),
  }
}

export async function saveProjectWebWatchConfig(input: Pick<ProjectWebWatchConfig, 'projectId' | 'enabled' | 'topics' | 'localTime'>): Promise<ProjectWebWatchConfig> {
  if (!await getProject(input.projectId)) throw new Error('项目不存在')
  const parts = input.localTime.split(':').map((part) => Number(part ?? ''))
  const hour = parts[0] ?? Number.NaN
  const minute = parts[1] ?? Number.NaN
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('扫描时间无效')
  const topics = [...new Set(input.topics.map((topic) => topic.trim()).filter(Boolean))]
  if (topics.length > MAX_TOPICS) throw new Error(`最多配置 ${MAX_TOPICS} 个扫描主题`)
  if (topics.some((topic) => topic.length > 200)) throw new Error('单个扫描主题不能超过 200 个字符')
  if (input.enabled && topics.length === 0) throw new Error('启用外网扫描前，请至少填写一个主题')
  const current = getProjectWebWatchConfig(input.projectId)
  const next = { ...current, ...input, topics, updatedAt: Date.now() }
  writeJsonFileAtomic(configPath(input.projectId), next)
  return next
}

export function listProjectWebWatchRuns(projectId: string): ProjectWebWatchRun[] {
  const path = runsPath(projectId)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as ProjectWebWatchRun] } catch { return [] }
  }).sort((a, b) => b.startedAt - a.startedAt).slice(0, 30)
}

export async function runProjectWebWatch(projectId: string, options: { notify?: boolean } = {}): Promise<ProjectWebWatchRun> {
  if (activeProjectIds.has(projectId)) throw new Error('该项目的外网扫描正在运行')
  activeProjectIds.add(projectId)
  try {
    const project = await getProject(projectId)
    if (!project) throw new Error('项目不存在')
    const config = getProjectWebWatchConfig(projectId)
    const startedAt = Date.now()
    const coverageFrom = config.lastSuccessAt ?? startedAt - 24 * 60 * 60 * 1000
    try {
      return await executeProjectWebWatch(projectId, options)
    } catch (error) {
      const endedAt = Date.now()
      const message = error instanceof Error ? error.message : String(error)
      const failed: ProjectWebWatchRun = { id: randomUUID(), projectId, startedAt, endedAt, coverageFrom, coverageTo: endedAt, status: 'failed', queries: config.topics, sources: [], newSources: [], error: message }
      const failures = (config.consecutiveFailures ?? 0) + 1
      const failureNotice = shouldNotifyFailure(config, failures, endedAt)
      finishRun(projectId, config, failed, {
        consecutiveFailures: failures,
        ...(failureNotice ? { lastFailureNotifiedAt: endedAt } : {}),
      })
      if (options.notify && failureNotice && getSettings().notificationsEnabled !== false) {
        sendSystemNotification({ title: `项目外网扫描失败：${project.title}`, body: failures >= 2 ? `${message}（已连续失败 ${failures} 次）` : message })
      }
      throw error
    }
  } finally {
    activeProjectIds.delete(projectId)
  }
}

async function executeProjectWebWatch(projectId: string, options: { notify?: boolean }): Promise<ProjectWebWatchRun> {
  const project = await getProject(projectId)
  if (!project) throw new Error('项目不存在')
  const config = getProjectWebWatchConfig(projectId)
  if (!config.topics.length) throw new Error('请先配置扫描主题')
  const startedAt = Date.now()
  const previous = listProjectWebWatchRuns(projectId).find((run) => run.status === 'success')
  const coverageFrom = config.lastSuccessAt ?? previous?.endedAt ?? startedAt - DAY_MS
  const runId = randomUUID()

  // 预算门禁先于搜索：额度已用尽时不做任何外部请求，也不产生观察记录。
  if (isOwnerBudgetExhausted(projectId)) return finishRun(projectId, config, {
    id: runId, projectId, startedAt, endedAt: Date.now(), coverageFrom, coverageTo: Date.now(),
    status: 'skipped', skipReason: 'budget_exhausted', queries: [], sources: [], newSources: [],
  })

  const channels = listChannels().filter((channel) => channel.enabled)
  const channel = channels.find((candidate) => candidate.models.some((model) => model.enabled))
  const model = channel?.models.find((candidate) => candidate.enabled)
  if (!channel || !model) throw new Error('请先启用一个包含可用模型的 AI 渠道')
  const caller = createProxiedLlmCaller({ provider: channel.provider, baseUrl: channel.baseUrl, apiKey: decryptApiKey(channel.id), modelId: model.id })

  const topics = config.topics.slice(0, MAX_TOPICS)
  const queries = topics.map((topic) => `${topic} ${new Date(coverageFrom).toISOString().slice(0, 10)} 以来`)
  const sources: WebSearchResultItem[] = []
  for (const query of queries) sources.push(...await searchWebResults(query))
  const uniqueSources = [...new Map(sources.filter((source) => source.url).map((source) => [source.url, source])).values()].slice(0, MAX_SOURCES)
  const knownVersions = new Map(listProjectWebWatchRuns(projectId).filter((run) => run.status === 'success').flatMap((run) => run.sources.map((source) => [source.url, source.snippet] as const)))
  const newSources = uniqueSources.filter((source) => knownVersions.get(source.url) !== source.snippet)

  const taskItems = await listTasks(projectId)
  const openTasks = taskItems.filter((task) => task.status !== 'completed').slice(0, 30)
    .map((task) => ({ title: task.title, status: task.status, ...(task.dueDate ? { dueAt: task.dueDate } : {}) }))
  const ownerContext = await loadOwnerObservationContext(projectId)
  const history: WebObservationHistoryEntry[] = listProjectWebChangeObservations(projectId, 20).map((item) => ({
    id: item.id,
    judgment: item.judgment,
    sourceIds: [...new Set(item.facts.map((fact) => fact.sourceId))],
    impact: item.impact,
    createdAt: item.createdAt,
  }))
  const prompt = buildWebObservationPrompt({
    project: { title: project.title, description: project.description },
    goal: ownerContext.goal,
    goalRevision: ownerContext.goalRevision,
    planSummary: ownerContext.planSummary,
    openTasks,
    history,
    feedback: listWebObservationFeedback(projectId, 20).map((item) => ({
      verdict: item.verdict,
      ...(item.sourceIds[0] ? { sourceId: item.sourceIds[0] } : {}),
      ...(item.reason ? { reason: item.reason } : {}),
    })),
    topics,
    coverage: { from: coverageFrom, to: startedAt },
    sources: newSources,
  })

  let rawResponse: string | null = null
  let callFailureReason: string | null = null
  try {
    rawResponse = await caller(prompt.prompt)
  } catch (error) {
    // 搜索成功但判断失败：不把整轮扫描记为 failed，改为 insufficient_evidence 观察留证。
    callFailureReason = error instanceof Error ? error.message : String(error)
  }

  const judged = judgeAndRecordWebObservation({
    projectId,
    runId,
    rawResponse,
    callFailureReason,
    sources: newSources,
    topics,
    goalRevision: ownerContext.goalRevision,
    contextFingerprint: ownerContext.fingerprint,
    modelId: model.id,
    promptVersion: WEB_OBSERVATION_PROMPT_VERSION,
    sourcesCount: newSources.length,
    truncated: prompt.truncated,
    existingObservationIds: history.map((item) => item.id),
    createdAt: startedAt,
  })

  // 只有需要人看的判定才进对话；record_only / duplicate / insufficient_evidence 只留账本。
  if (judged.observation && (judged.judgment === 'attention' || judged.judgment === 'decision_required')) {
    try { enqueueWebChangeObservation(judged.observation) }
    catch (error) { console.warn('[项目外网扫描] 观察投递失败，记录已保留:', error instanceof Error ? error.message : error) }
  }

  const endedAt = Date.now()
  const run = finishRun(projectId, config, {
    id: runId, projectId, startedAt, endedAt, coverageFrom, coverageTo: endedAt,
    status: 'success', queries, sources: uniqueSources, newSources,
    ...(judged.observation ? { observationId: judged.observation.id } : {}),
    judgment: judged.judgment,
    analysis: summaryOf(judged.judgment, judged.observation?.impact ?? null, judged.failureReason),
  })

  const worthNotifying = judged.judgment === 'attention' || judged.judgment === 'decision_required'
  const notify = Boolean(options.notify) && worthNotifying && shouldNotifySuccess(config, endedAt) && getSettings().notificationsEnabled !== false
  if (notify) {
    sendSystemNotification({ title: `项目外网扫描：${project.title}`, body: `发现 ${run.newSources.length} 条新来源，有 1 项可能影响项目的变化，打开项目查看判断与来源。` })
    // 同一天多条扫描合并为一条提醒：记下首次提醒时间。
    writeJsonFileAtomic(configPath(projectId), { ...getProjectWebWatchConfig(projectId), lastNotifiedAt: endedAt, updatedAt: Date.now() })
  }
  return run
}

/** 判断摘要：由结构化结论生成，不再回传模型自由文本。 */
function summaryOf(judgment: string, impact: string | null, failureReason: string | null): string {
  const labels: Record<string, string> = {
    record_only: '已记录，无需你处理',
    attention: '值得你了解',
    decision_required: '需要你做一个决定',
    insufficient_evidence: '证据不足，未形成结论',
    duplicate: '与既有观察重复，无新内容',
  }
  return [labels[judgment] ?? judgment, impact, failureReason ? `原因：${failureReason}` : null].filter(Boolean).join('；')
}

/** Owner 目标、方案与预算：都来自既有账本，只读，不改动任何状态。 */
async function loadOwnerObservationContext(projectId: string): Promise<{
  goal: { objective: string; constraints: string[]; acceptanceCriteria: string[] } | null
  goalRevision: number | null
  planSummary: string | null
  fingerprint: string | null
}> {
  try {
    const goals = await import('./project-owner-goal-service')
    const draft = goals.getProjectOwnerGoalDraft(projectId)
    if (!draft) return { goal: null, goalRevision: null, planSummary: null, fingerprint: null }
    let planSummary: string | null = null
    try {
      const plans = await import('./project-owner-plan-service')
      planSummary = plans.getProjectOwnerPlanDraft(projectId)?.proposal.summary ?? null
    } catch { planSummary = null }
    return {
      goal: { objective: draft.goal.objective, constraints: draft.goal.constraints, acceptanceCriteria: draft.goal.acceptanceCriteria },
      goalRevision: draft.revision,
      planSummary,
      fingerprint: null,
    }
  } catch {
    return { goal: null, goalRevision: null, planSummary: null, fingerprint: null }
  }
}

/**
 * Owner 模型额度只读门禁：沿用管理委托的既有占额，不新增结算记录。
 * 未知：扫描本身的费用目前不写入 Owner 账本，这一条属已知缺口，不能当已闭环。
 */
function isOwnerBudgetExhausted(projectId: string): boolean {
  try {
    const { getOwnerManagementDelegation } = require('./project-owner-management-delegation') as typeof import('./project-owner-management-delegation')
    const view = getOwnerManagementDelegation(projectId)
    if (!view.delegation) return false
    return (view.ownerModelBudget?.remainingMicros ?? 0) <= 0
  } catch {
    // 读不到账本时不阻断扫描，但预算门禁按未知处理，不声称已核对。
    return false
  }
}

/** 落盘一次运行：追加流水、按上限轮转、更新配置时间戳与失败计数。 */
function finishRun(projectId: string, config: ProjectWebWatchConfig, run: ProjectWebWatchRun, patch: Partial<ProjectWebWatchConfig> = {}): ProjectWebWatchRun {
  appendFileSync(runsPath(projectId), `${JSON.stringify(run)}\n`, 'utf8')
  rotateProjectWebWatchRuns(projectId)
  writeJsonFileAtomic(configPath(projectId), {
    ...config,
    lastAttemptAt: run.endedAt,
    ...(run.status === 'success' ? { lastSuccessAt: run.endedAt, consecutiveFailures: 0 } : {}),
    ...patch,
    updatedAt: run.endedAt,
  })
  return run
}


/** 只保留最近 90 次扫描流水；超出部分整行丢弃（每轮扫描后自动执行，测试直接调用）。 */
export function rotateProjectWebWatchRuns(projectId: string): void {
  const path = runsPath(projectId)
  if (!existsSync(path)) return
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  if (lines.length <= WEB_WATCH_RUN_RETENTION) return
  const kept = lines.slice(lines.length - WEB_WATCH_RUN_RETENTION)
  try {
    writeFileSync(path, `${kept.join('\n')}\n`, 'utf8')
  } catch (error) {
    console.warn('[项目外网扫描] 流水轮转失败，保留原文件:', error instanceof Error ? error.message : error)
  }
}

function createProxiedLlmCaller(config: { provider: import('@gravitas/shared').ProviderType; baseUrl: string; apiKey: string; modelId: string }): (prompt: string) => Promise<string> {
  const adapter = getAdapter(config.provider)
  return async (prompt) => {
    const request = adapter.buildTitleRequest({ ...config, prompt })
    const body = JSON.parse(request.body) as Record<string, unknown>
    body.max_tokens = 2200
    const proxyUrl = await getEffectiveProxyUrl()
    const response = await getFetchFn(proxyUrl)(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`AI 分析请求失败 (${response.status})`)
    const result = adapter.parseTitleResponse(await response.json())
    if (result === null) throw new Error('AI 分析响应解析失败')
    return result
  }
}

export async function tickProjectWebWatch(now = new Date()): Promise<void> {
  if (scanning) return
  scanning = true
  try {
    const { listProjects } = await import('./project-service')
    for (const project of await listProjects()) {
      const config = getProjectWebWatchConfig(project.id)
      if (!config.enabled || !isProjectWebWatchDue(config, now)) continue
      try { await runProjectWebWatch(project.id, { notify: true }) }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[项目外网扫描] ${project.id} 执行失败:`, message)
      }
    }
  } finally { scanning = false }
}

export function startProjectWebWatchScheduler(): void {
  if (timer) return
  void tickProjectWebWatch()
  timer = setInterval(() => { void tickProjectWebWatch() }, POLL_INTERVAL_MS)
  timer.unref()
}

export function stopProjectWebWatchScheduler(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
