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
import { extractMemoryCandidatesFromOutput } from './memory-plugin-service'
import { createMemoryApproval } from './approval-service'
import { createSkillApproval } from './approval-service'

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
 */
export async function runRoutineInstance(
  instanceId: string,
  target: ProactiveExecutionTarget,
): Promise<ProactiveTaskRun> {
  const instance = getRoutineInstance(instanceId)
  if (!instance) throw new Error('Routine 实例不存在')
  if (!instance.enabled) throw new Error('Routine 实例已停用')
  if (!target.channelId.trim() || !target.prompt.trim()) throw new Error('Routine 缺少渠道或执行内容')
  if (!target.newSession && !target.sessionId?.trim()) throw new Error('复用会话的 Routine 缺少目标会话')

  const prompt = `${renderRoutinePrompt(instance)}\n\n${target.prompt}`.trim()
  let run = runStore.saveRun({
    id: randomUUID(),
    sourceType: 'routine',
    sourceId: instance.id,
    sessionId: target.sessionId,
    status: 'running',
    trigger: 'manual',
    startedAt: Date.now(),
  })
  try {
    if (!routineRunner) throw new Error('Routine 执行器未就绪')
    const result = await routineRunner(instance, { ...target, prompt }, prompt)
    run = runStore.saveRun({ ...run, status: 'success', endedAt: Date.now(), outputSummary: result.outputSummary, sessionId: result.sessionId ?? run.sessionId })
    if (instance.manifestId.startsWith('proma-memory:') && result.output) {
      for (const candidate of extractMemoryCandidatesFromOutput(result.output, run.id, run.sessionId)) {
        createMemoryApproval(run.id, candidate.title, candidate.content, {
          kind: candidate.kind,
          tags: candidate.tags,
          confidence: candidate.confidence,
          sourceSessionId: candidate.sourceSessionId,
        })
      }
    }
    return run
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Routine 执行失败'
    run = runStore.saveRun({ ...run, status: 'failed', endedAt: Date.now(), error: message })
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
