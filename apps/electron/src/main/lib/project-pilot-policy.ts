import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { OwnerExecutionPreparationReference, PilotPolicyDraftInput } from '@gravitas/shared'
import { assertNoOwnerExecutionPreparation, assertOwnerExecutionBoundaryIdle } from './project-owner-execution-preparation-evidence'
import { getConfigDir } from './config-paths'
import { getProject, getProjectDb } from './project-sqlite-store'

/** 首版托管契约的持久边界。目前没有执行器消费该配置，也没有激活 IPC。 */
export interface PilotPolicy {
  version: 1
  projectId: string
  revision: number
  state: 'paused'
  ownerExecutionPreparation?: OwnerExecutionPreparationReference
  /** v2重新验证引用独立存在；存在时v1引用必须逐字节保留，两者均非授权。 */
  ownerExecutionRevalidation?: import('@gravitas/shared').OwnerExecutionRevalidationReference
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

const PATH = 'project-pilot-policies.json'
interface PolicyIndex { version: 1; policies: PilotPolicy[] }
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const positiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const nonNegativeInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const path = (): string => join(getConfigDir(), PATH)

/** 跨进程互斥读-校验-写；意外退出留下锁时默认拒绝写，需人工检查后恢复。 */
/** 供Owner准备/重验证service组合使用；mkdir锁不可重入，不要嵌套调用。 */
export function withPolicyLock<T>(operation: () => T): T {
  const lock = `${path()}.lock`
  try { mkdirSync(lock, { mode: 0o700 }) }
  catch {
    throw new Error(`Pilot 授权配置正在修改或遗留锁未核查（${lock}）；已停止写入。`
      + '确认没有进行中的 Pilot 操作后，人工核查并移除该锁目录即可恢复。')
  }
  try { return operation() }
  finally { rmdirSync(lock) }
}

/** 遗留策略锁的只读人工核查提示；不自动移除——锁存在即表示可能有并发修改。 */
export function getPilotPolicyLockHint(): string | null {
  const lock = `${path()}.lock`
  return fileExists(lock) ? lock : null
}

const fileExists = (file: string): boolean => {
  try { return lstatSync(file).isSymbolicLink() || existsSync(file) }
  catch { return false }
}

function validOwnerPreparationReference(raw: unknown): raw is OwnerExecutionPreparationReference {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const value = raw as Record<string, unknown>
  return Object.keys(value).every(key => ['schemaVersion','purpose','id','revision','integrityHash','stage'].includes(key))
    && value.schemaVersion === 1 && value.purpose === 'owner_business_execution_preparation'
    && nonEmpty(value.id) && positiveInt(value.revision) && typeof value.integrityHash === 'string'
    && /^[a-f0-9]{64}$/.test(value.integrityHash) && value.stage === 'pending_task_links'
}

function validOwnerRevalidationReference(raw: unknown): raw is import('@gravitas/shared').OwnerExecutionRevalidationReference {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const value = raw as Record<string, unknown>
  return Object.keys(value).every(key => ['schemaVersion','purpose','id','revision','integrityHash','stage','materializationId','materializationIntegrityHash'].includes(key))
    && value.schemaVersion === 1 && value.purpose === 'owner_business_execution_revalidation'
    && nonEmpty(value.id) && positiveInt(value.revision) && nonEmpty(value.materializationId)
    && typeof value.integrityHash === 'string' && /^[a-f0-9]{64}$/.test(value.integrityHash)
    && typeof value.materializationIntegrityHash === 'string' && /^[a-f0-9]{64}$/.test(value.materializationIntegrityHash)
    && value.stage === 'paused_task_links'
}

function validPolicy(value: unknown): value is PilotPolicy {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return p.version === 1 && nonEmpty(p.projectId) && positiveInt(p.revision)
    && p.state === 'paused' && (p.pauseDecisionFingerprint === undefined
      || (typeof p.pauseDecisionFingerprint === 'string' && /^[a-f0-9]{64}$/.test(p.pauseDecisionFingerprint)))
    && (p.ownerExecutionPreparation === undefined || validOwnerPreparationReference(p.ownerExecutionPreparation))
    && (p.ownerExecutionRevalidation === undefined || validOwnerRevalidationReference(p.ownerExecutionRevalidation))
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

/** 在跨进程策略锁内读取指定版本，供 SQLite grant 发行形成一致快照。 */
export function withPilotPolicySnapshot<T>(
  projectId: string,
  expectedRevision: number,
  operation: (policy: PilotPolicy) => T,
): T {
  if (!nonEmpty(projectId) || !positiveInt(expectedRevision)) throw new Error('Pilot 授权版本无效')
  return withPolicyLock(() => {
    const policy = readIndex().policies.find((item) => item.projectId === projectId)
    if (!policy || policy.revision !== expectedRevision) throw new Error('Pilot 授权版本已变化')
    return operation(policy)
  })
}

/** 草案持久化入口：已供项目经理 IPC 使用；写入始终暂停，不触发模型、任务或通知。 */
export function savePilotPolicyDraft(projectId: string, input: PilotPolicyDraftInput, expectedRevision: number | null): PilotPolicy {
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
    const activeGrant = getProjectDb().prepare("SELECT id FROM pilot_runtime_grants WHERE project_id = ? AND state = 'active' LIMIT 1")
      .get(projectId) as { id: string } | undefined
    if (activeGrant) throw new Error('项目存在活动 Pilot 授权，请先预览影响面并暂停')
    const index = readIndex()
    const previous = index.policies.find((p) => p.projectId === projectId)
    assertNoOwnerExecutionPreparation(projectId, previous?.ownerExecutionPreparation)
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

/** v2重新验证引用原子替换；v1引用与state逐字节保留，语义核验由调用方回调前完成。 */
/**
 * 仅替换v2引用；必须在withPolicyLock内调用（mkdir锁不可重入），DB证据应由调用方先commit。
 * v1引用与state逐字节保留；语义核验（v2记录存在且hash相符）由调用方在构建reference前完成。
 */
export function saveOwnerRevalidationPolicy(
  projectId: string, expectedRevision: number,
  build: (nextRevision: number) => import('@gravitas/shared').OwnerExecutionRevalidationReference,
): PilotPolicy {
  const index = readIndex(), previous = index.policies.find(item => item.projectId === projectId)
  if (!previous || previous.revision !== expectedRevision) throw new Error('Owner策略已更新，请重新预览')
  if (!previous.ownerExecutionPreparation) throw new Error('Owner重验证要求已存在的v1准备引用')
  if (previous.state !== 'paused') throw new Error('Owner策略状态已变化')
  const revision = previous.revision + 1
  const reference = build(revision)
  const policy: PilotPolicy = { ...previous, revision, ownerExecutionRevalidation: reference, updatedAt: Date.now() }
  if (!validPolicy(policy)) throw new Error('Owner重验证策略无效')
  writeIndex({ version: 1, policies: [...index.policies.filter(item => item.projectId !== projectId), policy] })
  const current = getPilotPolicy(projectId)
  if (!current || JSON.stringify(current) !== JSON.stringify(policy) || JSON.stringify(current.ownerExecutionPreparation) !== JSON.stringify(previous.ownerExecutionPreparation)) throw new Error('Owner重验证策略替换未确认，请保留证据核查')
  return current
}

/** 仅供Owner准备service使用；先持久证据再原子替换JSON，不能声称跨存储事务。 */
export function saveOwnerPreparationPolicy(
  projectId: string, expectedRevision: number | null,
  build: (nextRevision: number) => { input: PilotPolicyDraftInput; reference: OwnerExecutionPreparationReference },
): PilotPolicy {
  if (getProjectDb().isTransactionActive()) throw new Error('Owner暂停策略保存拒绝未提交外层事务')
  if (!getProject(projectId)) throw new Error('Owner项目不存在')
  return withPolicyLock(() => {
    assertOwnerExecutionBoundaryIdle(projectId)
    const index = readIndex(), previous = index.policies.find(item => item.projectId === projectId)
    if ((previous?.revision ?? null) !== expectedRevision) throw new Error('Owner策略已更新，请重新预览')
    // v2存在时v1引用不可被重存覆盖；重新验证链只能经saveOwnerRevalidationPolicy前进。
    if (previous?.ownerExecutionRevalidation) throw new Error('Owner策略已由v2重新验证接管，不能重存v1准备；请保留证据核查')
    const revision = (previous?.revision ?? 0) + 1
    const { input, reference } = build(revision)
    const policy: PilotPolicy = { ...input, version: 1, projectId, revision, state: 'paused', ownerExecutionPreparation: reference, updatedAt: Date.now() }
    if (!validPolicy(policy)) throw new Error('Owner暂停准备策略无效')
    writeIndex({ version: 1, policies: [...index.policies.filter(item => item.projectId !== projectId), policy] })
    const current = getPilotPolicy(projectId)
    if (!current || JSON.stringify(current) !== JSON.stringify(policy)) throw new Error('Owner准备策略替换未确认，请保留证据核查')
    return current
  })
}
