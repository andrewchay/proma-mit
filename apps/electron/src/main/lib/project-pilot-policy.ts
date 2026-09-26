import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { getConfigDir } from './config-paths'
import { getProject } from './project-sqlite-store'

/** 首版托管契约的持久边界。目前没有执行器消费该配置，也没有激活 IPC。 */
export interface PilotPolicy {
  version: 1
  projectId: string
  revision: number
  state: 'paused'
  pauseDecisionFingerprint?: string
  workspaceId: string
  employeeIds: string[]
  /** 旧版草案可能缺少职责绑定；缺失时预检必须阻塞。 */
  executorEmployeeId?: string
  reviewerEmployeeId?: string
  modelId: string
  channelId: string
  maxCostMicros: number
  maxRuns: number
  maxRework: number
  expiresAt: number
  updatedAt: number
}

export interface PilotDraftInput {
  workspaceId: string
  employeeIds: string[]
  executorEmployeeId: string
  reviewerEmployeeId: string
  modelId: string
  channelId: string
  maxCostMicros: number
  maxRuns: number
  maxRework: number
  expiresAt: number
}

const PATH = 'project-pilot-policies.json'
interface PolicyIndex { version: 1; policies: PilotPolicy[] }
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const positiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const nonNegativeInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const path = (): string => join(getConfigDir(), PATH)

/** 跨进程互斥读-校验-写；意外退出留下锁时默认拒绝写，需人工检查后恢复。 */
function withPolicyLock<T>(operation: () => T): T {
  const lock = `${path()}.lock`
  try { mkdirSync(lock, { mode: 0o700 }) }
  catch { throw new Error('Pilot 授权配置正在修改或遗留锁未核查；已停止写入') }
  try { return operation() }
  finally { rmdirSync(lock) }
}

const fileExists = (file: string): boolean => {
  try { return lstatSync(file).isSymbolicLink() || existsSync(file) }
  catch { return false }
}

function validPolicy(value: unknown): value is PilotPolicy {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return p.version === 1 && nonEmpty(p.projectId) && positiveInt(p.revision)
    && p.state === 'paused' && (p.pauseDecisionFingerprint === undefined
      || (typeof p.pauseDecisionFingerprint === 'string' && /^[a-f0-9]{64}$/.test(p.pauseDecisionFingerprint)))
    && nonEmpty(p.workspaceId)
    && Array.isArray(p.employeeIds) && p.employeeIds.length > 0
    && p.employeeIds.every(nonEmpty) && new Set(p.employeeIds).size === p.employeeIds.length
    && ((p.executorEmployeeId === undefined && p.reviewerEmployeeId === undefined)
      || (nonEmpty(p.executorEmployeeId) && nonEmpty(p.reviewerEmployeeId)
        && p.executorEmployeeId !== p.reviewerEmployeeId
        && p.employeeIds.includes(p.executorEmployeeId) && p.employeeIds.includes(p.reviewerEmployeeId)))
    && nonEmpty(p.modelId) && nonEmpty(p.channelId) && positiveInt(p.maxCostMicros)
    && positiveInt(p.maxRuns) && nonNegativeInt(p.maxRework)
    && positiveInt(p.expiresAt) && nonNegativeInt(p.updatedAt)
}

function readIndex(): PolicyIndex {
  if (!fileExists(path())) return { version: 1, policies: [] }
  if (!lstatSync(path()).isFile()) throw new Error('Pilot 授权配置不是普通文件；已停止管理操作')
  // 配置损坏必须拒绝操作，不能默默回退成空文件再覆盖用户之前的授权。
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(path(), 'utf8')) }
  catch { throw new Error('Pilot 授权配置无法读取；已停止管理操作') }
  if (!parsed || typeof parsed !== 'object') throw new Error('Pilot 授权配置无效；已停止管理操作')
  const index = parsed as Record<string, unknown>
  if (index.version !== 1 || !Array.isArray(index.policies) || !index.policies.every(validPolicy)) {
    throw new Error('Pilot 授权配置无效；已停止管理操作')
  }
  const policies = index.policies as PilotPolicy[]
  if (new Set(policies.map((p) => p.projectId)).size !== policies.length) {
    throw new Error('Pilot 授权配置项目重复；已停止管理操作')
  }
  return { version: 1, policies }
}

function writeIndex(index: PolicyIndex): void {
  const target = path()
  if (fileExists(target) && !lstatSync(target).isFile()) throw new Error('Pilot 授权配置不是普通文件')
  const temp = `${target}.${randomUUID()}.tmp`
  let renamed = false
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(index), 'utf8')
      fsyncSync(fd)
    } finally { closeSync(fd) }
    renameSync(temp, target)
    renamed = true
  } finally {
    if (!renamed) { try { unlinkSync(temp) } catch { /* ignore */ } }
  }
  // rename 后不能再将失败报告为“未写入”：revision 可能已生效。
  // 本文件永远 paused、无执行器消费；目录 fsync 失败时仅告警并让调用方读盘核对。
  try {
    const dirFd = openSync(dirname(target), 'r')
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  } catch (error) {
    console.warn('[Pilot] 策略草案已替换，目录同步未确认；重启后以读盘结果为准', error)
  }
  // 本模块尚无执行器消费，未来重启后必须以持久命令账本对账。
}

export function getPilotPolicy(projectId: string): PilotPolicy | null {
  if (!nonEmpty(projectId)) throw new Error('缺少项目 ID')
  return readIndex().policies.find((p) => p.projectId === projectId) ?? null
}

/** 内部草案持久化入口：尚未公开为 IPC；写入始终暂停，不触发模型、任务或通知。 */
export function savePilotPolicyDraft(projectId: string, input: PilotDraftInput, expectedRevision: number | null): PilotPolicy {
  if (!nonEmpty(projectId) || !getProject(projectId)) throw new Error('项目不存在')
  if (!nonEmpty(input?.workspaceId) || !nonEmpty(input.modelId) || !nonEmpty(input.channelId)
    || !Array.isArray(input.employeeIds) || !input.employeeIds.length
    || !input.employeeIds.every(nonEmpty) || new Set(input.employeeIds).size !== input.employeeIds.length
    || !nonEmpty(input.executorEmployeeId) || !nonEmpty(input.reviewerEmployeeId)
    || input.executorEmployeeId === input.reviewerEmployeeId
    || !input.employeeIds.includes(input.executorEmployeeId) || !input.employeeIds.includes(input.reviewerEmployeeId)
    || !positiveInt(input.maxCostMicros) || !positiveInt(input.maxRuns)
    || !nonNegativeInt(input.maxRework) || !positiveInt(input.expiresAt) || input.expiresAt <= Date.now()) {
    throw new Error('Pilot 策略草案必须限定工作区、员工、模型、预算、次数和有效期')
  }
  return withPolicyLock(() => {
    const index = readIndex()
    const previous = index.policies.find((p) => p.projectId === projectId)
    if ((previous?.revision ?? null) !== expectedRevision) throw new Error('Pilot 授权版本已变化')
    const policy: PilotPolicy = { version: 1, projectId, revision: (previous?.revision ?? 0) + 1,
      // 契约仅落为草案；待预算扣减、命令幂等和人工授权入口接通后另设激活事务。
      state: 'paused', workspaceId: input.workspaceId, employeeIds: [...input.employeeIds],
      executorEmployeeId: input.executorEmployeeId, reviewerEmployeeId: input.reviewerEmployeeId,
      modelId: input.modelId, channelId: input.channelId, maxCostMicros: input.maxCostMicros,
      maxRuns: input.maxRuns, maxRework: input.maxRework, expiresAt: input.expiresAt, updatedAt: Date.now() }
    writeIndex({ version: 1, policies: [...index.policies.filter((p) => p.projectId !== projectId), policy] })
    return policy
  })
}

/** 当前仅更新始终 paused 的内部草案；主动暂停须经 project-pilot-pause-impact 的影响面确认入口；本函数自身只更新草案。 */
export function pausePilotPolicy(projectId: string, expectedRevision: number, decisionFingerprint?: string): PilotPolicy {
  if (!nonEmpty(projectId) || !positiveInt(expectedRevision)
    || (decisionFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(decisionFingerprint))) throw new Error('Pilot 授权版本无效')
  return withPolicyLock(() => {
    const index = readIndex()
    const previous = index.policies.find((p) => p.projectId === projectId)
    if (!previous || previous.revision !== expectedRevision) throw new Error('Pilot 授权版本已变化')
    const policy: PilotPolicy = { ...previous, state: 'paused', pauseDecisionFingerprint: decisionFingerprint,
      revision: previous.revision + 1, updatedAt: Date.now() }
    writeIndex({ version: 1, policies: [...index.policies.filter((p) => p.projectId !== projectId), policy] })
    return policy
  })
}

/** 必须在每一次动作前读盘；未知、过期、暂停、预算/运行次数未知均不得执行。 */
export function assertPilotPolicyActive(projectId: string, now = Date.now()): never {
  // 暂无具备授权来源、额度扣减及命令幂等的激活路径；即便磁盘内容被手动改为 active 也不可运行。
  void now
  getPilotPolicy(projectId)
  throw new Error('Pilot 未获有效托管授权')
}
