/**
 * RoutineService - 可复用工作流模板管理
 *
 * Routine 是可以被 Schedule 或 Monitor 引用的工作流模板。
 * 支持内置 routine 和插件提供的 routine。
 *
 * 当前为骨架实现，支持：
 * - Routine manifest 定义和加载
 * - 内置 routine 注册
 * - 插件 routine 发现
 * - CRUD 操作
 *
 * 待实现：
 * - 插件安装/卸载
 * - SOP candidate → Skill 审批流
 * - Routine 市场
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getProactiveConfigPath, getConfigDir } from './config-paths'
import type { ProactiveExecutionTarget, ProactiveTaskRun } from '@gravitas/shared'
import { ProactiveSchedulerStore } from './proactive-scheduler-store'
import { ProactiveExecutionError } from './proactive-target-validation'
import { extractMemoryItemsBlock, extractMemoryCandidatesFromOutput, runMemoryMaintenance } from './memory-plugin-service'
import { buildMemoryRoutineContext } from './memory-routine-context'
import { createMemoryApproval, getPendingApprovals } from './approval-service'
import { createSkillApproval } from './approval-service'

// ===== 记忆 Routine 输出契约 =====

/**
 * proma-memory 系列 Routine 的结构化输出契约。
 * 解析器（memory-plugin-service.extractMemoryCandidatesFromOutput）只识别这个 fenced block；
 * 提示词与解析器必须保持同步，否则「模型正常回答」也会产出零候选。
 */
const MEMORY_OUTPUT_CONTRACT = `【输出要求】将提取出的记忆条目严格输出为下面这一个代码块（JSON 必须合法，不要输出其他代码块）：
\`\`\`proma-memory-items
{"items":[{"title":"条目标题","content":"具体内容与依据","kind":"preference|correction|sop|diary|fact","tags":["标签"],"confidence":0.8}]}
\`\`\`
只输出资料中真实出现的信息；不要调用 Bash、Read、Grep 或其他工具自行扫描文件，只使用上面提供的授权资料；确实没有新记忆时输出 {"items":[]}。`

function isMemoryRoutine(manifestId: string): boolean {
  return manifestId.startsWith('proma-memory:')
}

// ===== 类型定义 =====

export interface RoutineManifest {
  id: string
  name: string
  version: string
  description: string
  author?: string
  promptTemplate: string
  defaultSchedule?: {
    type: 'at' | 'interval' | 'cron'
    config: string
    timezone?: string
  }
  permissionProfile: string
  inputs?: Array<{
    name: string
    type: 'string' | 'number' | 'boolean' | 'select'
    required: boolean
    default?: unknown
    options?: string[]
  }>
  outputs?: Array<{
    name: string
    type: string
    description: string
  }>
}

export interface RoutineInstance {
  id: string
  manifestId: string
  title: string
  inputs: Record<string, unknown>
  enabled: boolean
  createdAt: number
  updatedAt: number
}

// ===== 内置 Routines =====

const BUILTIN_ROUTINES: RoutineManifest[] = [
  {
    id: 'proma-memory:memory-daily',
    name: '每日记忆整理',
    version: '1.0.0',
    description: '每天整理当天会话，提取长期偏好、纠正、SOP 候选和工作日志',
    promptTemplate: '请整理 {{date}} 的会话记录，提取：\n1. 长期偏好\n2. 纠正记录\n3. SOP 候选\n4. 工作日志',
    defaultSchedule: {
      type: 'cron',
      config: '0 23 * * *',
      timezone: 'Asia/Shanghai',
    },
    permissionProfile: 'memory-daily-default',
    inputs: [
      { name: 'date', type: 'string', required: false, default: '{{today}}' },
      { name: 'includeAgentSessions', type: 'boolean', required: false, default: true },
      { name: 'includeChatConversations', type: 'boolean', required: false, default: true },
    ],
    outputs: [
      { name: 'memoryItems', type: 'array', description: '提取的记忆条目' },
      { name: 'corrections', type: 'array', description: '纠正记录' },
      { name: 'sopCandidates', type: 'array', description: 'SOP 候选' },
    ],
  },
  {
    id: 'proma-memory:memory-init',
    name: '记忆初始化',
    version: '1.0.0',
    description: '首次使用时初始化用户记忆档案',
    promptTemplate: '请根据历史会话初始化用户记忆档案，包括：\n1. 用户偏好\n2. 常用工作流\n3. 重要项目',
    permissionProfile: 'memory-init',
    inputs: [
      { name: 'lookbackDays', type: 'number', required: false, default: 30 },
    ],
    outputs: [
      { name: 'profile', type: 'object', description: '用户档案' },
    ],
  },
  {
    id: 'proma-memory:weekly-review',
    name: '周回顾',
    version: '1.0.0',
    description: '每周回顾工作成果，整理 SOP 候选和下周计划',
    promptTemplate: '请回顾本周工作：\n1. 完成的主要任务\n2. 产生的 SOP 候选\n3. 下周计划建议',
    defaultSchedule: {
      type: 'cron',
      config: '0 18 * * 5',
      timezone: 'Asia/Shanghai',
    },
    permissionProfile: 'weekly-review',
    inputs: [
      { name: 'weekStart', type: 'string', required: false },
    ],
    outputs: [
      { name: 'summary', type: 'string', description: '周回顾总结' },
      { name: 'sopCandidates', type: 'array', description: 'SOP 候选' },
    ],
  },
  {
    id: 'proma-release:release-monitor',
    name: 'Release 监控',
    version: '1.0.0',
    description: '监控 GitHub Release 状态变化',
    promptTemplate: '检查 {{repo}} 的 release 状态，报告：\n1. 最新 release\n2. 未关闭的 issue\n3. CI 状态',
    permissionProfile: 'release-monitor-readonly',
    inputs: [
      { name: 'repo', type: 'string', required: true },
      { name: 'includeIssues', type: 'boolean', required: false, default: true },
    ],
    outputs: [
      { name: 'status', type: 'string', description: 'Release 状态' },
    ],
  },
  {
    id: 'proma-approval:digest',
    name: '审批摘要',
    version: '1.0.0',
    description: '定期汇总待审批事项',
    promptTemplate: '汇总当前待审批事项，按优先级排序，提供建议',
    defaultSchedule: {
      type: 'interval',
      config: '24h',
    },
    permissionProfile: 'read-only-review',
    outputs: [
      { name: 'digest', type: 'string', description: '审批摘要' },
    ],
  },
]

// ===== 存储 =====

const ROUTINES_FILE = 'routine-instances.json'
const PLUGINS_DIR = 'plugins'

let instancesCache: RoutineInstance[] | null = null
const runStore = new ProactiveSchedulerStore()

export interface RoutineRunResult {
  outputSummary?: string
  output?: string
  sessionId?: string
}

export type RoutineRunner = (
  instance: RoutineInstance,
  target: ProactiveExecutionTarget,
  prompt: string,
) => Promise<RoutineRunResult>

let routineRunner: RoutineRunner | undefined

/** 由 Agent 服务注入，确保 Routine 不能跳过渠道、会话和权限边界。 */
export function setRoutineRunner(runner: RoutineRunner): void {
  routineRunner = runner
}

/** 仅用于行为测试，清理模块级状态。 */
export function resetRoutineServiceForTests(): void {
  instancesCache = null
  routineRunner = undefined
}

function getRoutinesFilePath(): string {
  return join(getProactiveConfigPath(), ROUTINES_FILE)
}

function getPluginsDir(): string {
  const dir = join(getConfigDir(), PLUGINS_DIR)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function loadInstances(): RoutineInstance[] {
  if (instancesCache) return instancesCache
  const path = getRoutinesFilePath()
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    instancesCache = Array.isArray(data) ? data : []
    return instancesCache
  } catch {
    return []
  }
}

function saveInstances(instances: RoutineInstance[]): void {
  const dir = getProactiveConfigPath()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getRoutinesFilePath(), JSON.stringify(instances, null, 2))
  instancesCache = instances
}

// ===== Routine Manifest 管理 =====

/** 获取所有可用 routine manifests（内置 + 插件） */
export function listRoutineManifests(): RoutineManifest[] {
  const manifests = [...BUILTIN_ROUTINES]

  // 扫描插件目录
  const pluginsDir = getPluginsDir()
  if (existsSync(pluginsDir)) {
    for (const pluginDir of readdirSync(pluginsDir)) {
      const manifestPath = join(pluginsDir, pluginDir, 'manifest.json')
      if (existsSync(manifestPath)) {
        try {
          const pluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
          if (pluginManifest.routines) {
            for (const routine of pluginManifest.routines) {
              manifests.push({
                ...routine,
                id: `${pluginManifest.id}:${routine.id}`,
              })
            }
          }
        } catch {
          // 跳过无效 manifest
        }
      }
    }
  }

  return manifests
}

export function getRoutineManifest(id: string): RoutineManifest | undefined {
  return listRoutineManifests().find((m) => m.id === id)
}

// ===== Routine Instance CRUD =====

export function listRoutineInstances(): RoutineInstance[] {
  return loadInstances()
}

export function getRoutineInstance(id: string): RoutineInstance | undefined {
  return loadInstances().find((i) => i.id === id)
}

export interface CreateRoutineInstanceInput {
  manifestId: string
  title: string
  inputs?: Record<string, unknown>
}

export function createRoutineInstance(input: CreateRoutineInstanceInput): RoutineInstance | null {
  const manifest = getRoutineManifest(input.manifestId)
  if (!manifest) return null

  const instance: RoutineInstance = {
    id: randomUUID(),
    manifestId: input.manifestId,
    title: input.title,
    inputs: input.inputs ?? {},
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const instances = loadInstances()
  instances.push(instance)
  saveInstances(instances)
  return instance
}

export function updateRoutineInstance(
  id: string,
  updates: Partial<Omit<RoutineInstance, 'id' | 'createdAt'>>
): RoutineInstance | null {
  const instances = loadInstances()
  const idx = instances.findIndex((i) => i.id === id)
  if (idx === -1) return null
  const updated = { ...instances[idx], ...updates, updatedAt: Date.now() }
  instances[idx] = updated as RoutineInstance
  saveInstances(instances)
  return instances[idx]
}

export function deleteRoutineInstance(id: string): boolean {
  const instances = loadInstances()
  const filtered = instances.filter((i) => i.id !== id)
  if (filtered.length === instances.length) return false
  saveInstances(filtered)
  return true
}

export function setRoutineInstanceEnabled(id: string, enabled: boolean): boolean {
  return updateRoutineInstance(id, { enabled }) !== null
}

// ===== 渲染 Prompt =====

/**
 * 渲染 routine 的 prompt template，替换变量
 */
export function renderRoutinePrompt(instance: RoutineInstance): string {
  const manifest = getRoutineManifest(instance.manifestId)
  if (!manifest) return ''

  let prompt = manifest.promptTemplate

  // 替换输入变量
  for (const [key, value] of Object.entries(instance.inputs)) {
    prompt = prompt.replace(new RegExp(`{{${key}}}`, 'g'), String(value ?? ''))
  }

  // 替换默认变量
  const today = new Date().toISOString().split('T')[0]
  prompt = prompt.split('{{today}}').join(today)
  prompt = prompt.split('{{date}}').join(today)

  return prompt
}

/**
 * 手动运行 Routine 实例，并将结果写入与 Scheduler/Monitor 共享的 Run store。
 * Routine 本身不持有隐式执行上下文，调用者必须显式提供受控 target。
 *
 * trigger / parentRunId：由 Schedule/Monitor 包装调用时传入，保证内层运行
 * 继承真实触发来源并与外层运行关联（避免父子重复统计、假 manual 触发）。
 */
export async function runRoutineInstance(
  instanceId: string,
  target: ProactiveExecutionTarget,
  trigger: ProactiveTaskRun['trigger'] = 'manual',
  parentRunId?: string,
): Promise<ProactiveTaskRun> {
  const instance = getRoutineInstance(instanceId)
  if (!instance) throw new Error('Routine 实例不存在')
  if (!instance.enabled) throw new Error('Routine 实例已停用')
  if (!target.channelId.trim() || !target.prompt.trim()) throw new Error('Routine 缺少渠道或执行内容')
  if (!target.newSession && !target.sessionId?.trim()) throw new Error('复用会话的 Routine 缺少目标会话')

  const memoryRoutine = isMemoryRoutine(instance.manifestId)
  // 记忆 Routine：装配被授权范围内的近期会话资料作为输入，并约定结构化输出契约。
  // 装配失败降级为空输入（阶段会记录为 no_input），绝不让整理任务整体失败。
  let contextText = ''
  let contextItemCount = 0
  if (memoryRoutine) {
    try {
      const lookbackDays = Number(instance.inputs.lookbackDays) > 0 ? Number(instance.inputs.lookbackDays) : 7
      const context = buildMemoryRoutineContext(lookbackDays)
      contextText = context.text
      contextItemCount = context.itemCount
    } catch (error) {
      console.warn('[Routine] 记忆资料装配失败，按空输入继续:', error)
    }
  }
  const prompt = [
    renderRoutinePrompt(instance),
    target.prompt,
    memoryRoutine ? MEMORY_OUTPUT_CONTRACT : '',
    contextText,
  ].filter(Boolean).join('\n\n').trim()

  let run = runStore.saveRun({
    id: randomUUID(),
    sourceType: 'routine',
    sourceId: instance.id,
    sourceTitle: instance.title,
    sessionId: target.sessionId,
    status: 'running',
    trigger,
    parentRunId,
    startedAt: Date.now(),
  })
  try {
    if (!routineRunner) throw new Error('Routine 执行器未就绪')
    const result = await routineRunner(instance, { ...target, prompt }, prompt)
    run = runStore.saveRun({ ...run, status: 'success', endedAt: Date.now(), outputSummary: result.outputSummary, output: result.output, sessionId: result.sessionId ?? run.sessionId })
    if (memoryRoutine) {
      // 阶段追踪：区分「真实无新记忆」与「没有输入 / 输出不合契约」，不再把两者混为成功。
      const blockItems = result.output ? extractMemoryItemsBlock(result.output) : null
      const candidates = blockItems
        ? extractMemoryCandidatesFromOutput(result.output!, run.id, run.sessionId)
        : []
      // 幂等：同标题的待审批记忆候选已存在时跳过，避免重试产生重复审批
      const pendingTitles = new Set(
        getPendingApprovals()
          .filter((approval) => approval.sourceType === 'memory')
          .map((approval) => approval.title),
      )
      let skippedDuplicates = 0
      for (const candidate of candidates) {
        const approvalTitle = `记忆写入: ${candidate.title}`
        if (pendingTitles.has(approvalTitle)) { skippedDuplicates += 1; continue }
        createMemoryApproval(run.id, candidate.title, candidate.content, {
          kind: candidate.kind,
          tags: candidate.tags,
          confidence: candidate.confidence,
          sourceSessionId: candidate.sourceSessionId,
        })
        pendingTitles.add(approvalTitle)
      }
      if (skippedDuplicates > 0) {
        console.log(`[Routine] ${skippedDuplicates} 条记忆候选与已有待审批重复，已跳过（幂等）`)
      }
      const memoryStage = !result.output
        ? 'no_output'
        : candidates.length > 0
          ? 'pending_approval'
          // 输出缺少合法契约块（无标记或 JSON 非法）：模型未按契约输出
          : blockItems === null
            ? 'invalid_output'
            : contextItemCount === 0
              ? 'no_input'
              : 'no_new'
      run = runStore.saveRun({ ...run, memoryStage, memoryCandidates: candidates.length })
    }
    // Maintain：每日记忆整理成功后执行巩固（相似合并）与遗忘（低效用超期归档，可回滚）
    if (instance.manifestId === 'proma-memory:memory-daily') {
      try {
        const report = runMemoryMaintenance()
        if (report.mergedGroups > 0 || report.forgottenIds.length > 0) {
          console.log(`[Routine] 记忆维护完成：合并 ${report.mergedGroups} 组，归档 ${report.forgottenIds.length} 条（活跃 ${report.activeBefore} → ${report.activeAfter}）`)
        }
      } catch (error) {
        console.error('[Routine] 记忆维护执行失败:', error)
      }
    }
    return run
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Routine 执行失败'
    run = runStore.saveRun({ ...run, sessionId: error instanceof ProactiveExecutionError ? error.sessionId : run.sessionId, status: 'failed', endedAt: Date.now(), error: message })
    return run
  }
}

// ===== SOP Candidate → Skill 审批流 =====

export interface SOPCandidate {
  id: string
  title: string
  description: string
  steps: string[]
  sourceSessionId?: string
  createdAt: number
}

/**
 * 提交 SOP 候选为 Skill（需要审批）
 */
export function submitSOPCandidate(candidate: SOPCandidate, workspaceId: string): { approvalId: string } | null {
  if (!candidate.title.trim() || candidate.steps.length === 0 || !workspaceId.trim()) return null
  const content = [
    `# ${candidate.title}`,
    '',
    candidate.description.trim(),
    '',
    '## 步骤',
    ...candidate.steps.map((step, index) => `${index + 1}. ${step}`),
  ].join('\n')
  const approval = createSkillApproval(undefined, workspaceId, candidate.title, content)
  return { approvalId: approval.id }
}

// ===== IPC 处理器注册 =====

export function registerRoutineIPCHandlers(): void {
  const { ipcMain } = require('electron')

  ipcMain.handle('proactive:listRoutineManifests', () => listRoutineManifests())
  ipcMain.handle('proactive:getRoutineManifest', (_event: unknown, id: string) => getRoutineManifest(id))
  ipcMain.handle('proactive:listRoutineInstances', () => listRoutineInstances())
  ipcMain.handle('proactive:createRoutineInstance', (_event: unknown, input: CreateRoutineInstanceInput) => createRoutineInstance(input))
  ipcMain.handle('proactive:updateRoutineInstance', (_event: unknown, id: string, updates: Partial<Omit<RoutineInstance, 'id' | 'createdAt'>>) => updateRoutineInstance(id, updates))
  ipcMain.handle('proactive:deleteRoutineInstance', (_event: unknown, id: string) => deleteRoutineInstance(id))
  ipcMain.handle('proactive:setRoutineInstanceEnabled', (_event: unknown, id: string, enabled: boolean) => setRoutineInstanceEnabled(id, enabled))
  ipcMain.handle('proactive:runRoutineInstance', (_event: unknown, instanceId: string, target: ProactiveExecutionTarget) => runRoutineInstance(instanceId, target))
  ipcMain.handle('proactive:submitSOPCandidate', (_event: unknown, candidate: SOPCandidate, workspaceId: string) => submitSOPCandidate(candidate, workspaceId))
  ipcMain.handle('proactive:renderRoutinePrompt', (_event: unknown, instanceId: string) => {
    const instance = getRoutineInstance(instanceId)
    return instance ? renderRoutinePrompt(instance) : null
  })
}
