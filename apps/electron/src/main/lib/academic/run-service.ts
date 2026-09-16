/**
 * 研究运行应用服务（M4）
 *
 * 负责：创建运行记录（冻结输入清单）、驱动执行器、记录状态与产物、
 * 手工观察登记、取消。
 *
 * 关键约束：
 * - 运行前冻结输入清单摘要，事后可比对（方案 §7）
 * - completed 只表示进程正常结束，不代表结论成立（方案 §11.4）
 * - 产物引用分「本地文件（算 sha256 = verified）」与「外部引用（unverified）」
 * - 日志写入 <config>/academic/research/<projectId>/run-logs/<runId>.log
 */

import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type {
  ResearchProject,
  ResearchRun,
  ResearchRunKind,
  RunArtifact,
  RunBudget,
  RunInputManifest,
  RunObservation,
} from '@gravitas/shared'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'
import { digestInputManifest, validateRunRequest } from '@gravitas/core/services/academic'
import { appendEvent, loadProjectState, readProjectEvents, getResearchDir } from './research-store'
import { assertProjectAccess, currentActor } from './access-guard'
import { classifyArtifactRef, LocalRunExecutor, sha256File, type RunExecutor } from './run-executor'

/** 服务依赖：测试注入假执行器与项目根解析 */
export interface RunServiceDeps {
  executor?: RunExecutor
  /** 项目工作目录（脚本与产物相对此目录）；缺省用研究数据目录 */
  resolveProjectRoot?: (projectId: string) => string
}

function defaultProjectRoot(projectId: string): string {
  // MVP：研究项目的工作目录固定在研究数据目录下（后续接入外部项目根）
  const dir = join(getResearchDir(projectId), 'workdir')
  return dir
}

async function loadProject(id: string): Promise<ResearchProject | null> {
  const state = await loadProjectState(id)
  return state.project
}

/** 列出运行记录（最近在前） */
export async function listRuns(projectId: string): Promise<ResearchRun[]> {
  await assertProjectAccess(projectId, loadProject)
  const events = await readProjectEvents(projectId)
  const runs = new Map<string, ResearchRun>()
  for (const envelope of events) {
    const p = envelope.payload
    if (p.type === 'run_recorded') runs.set(p.run.id, p.run)
    if (p.type === 'run_status_changed') {
      const run = runs.get(p.runId)
      if (run) {
        run.status = p.status
        run.exitCode = p.exitCode
        run.statusReason = p.statusReason
        run.logRef = p.logRef ?? run.logRef
        if (['completed', 'failed', 'cancelled', 'timed-out'].includes(p.status)) {
          run.finishedAt = envelope.at
        }
      }
    }
  }
  return [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** 列出观察记录 */
export async function listObservations(projectId: string): Promise<RunObservation[]> {
  await assertProjectAccess(projectId, loadProject)
  const events = await readProjectEvents(projectId)
  return events
    .filter((e) => e.payload.type === 'observation_recorded')
    .map((e) => (e.payload as { observation: RunObservation }).observation)
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
}

/** 列出产物 */
export async function listArtifacts(projectId: string): Promise<RunArtifact[]> {
  await assertProjectAccess(projectId, loadProject)
  const events = await readProjectEvents(projectId)
  return events
    .filter((e) => e.payload.type === 'artifact_recorded')
    .map((e) => (e.payload as { artifact: RunArtifact }).artifact)
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
}

export interface CreateRunInput {
  kind: ResearchRunKind
  title: string
  input: RunInputManifest
  budget?: Partial<RunBudget>
  protocolVersion?: number
}

/**
 * 创建并（compute 类型）执行一次运行。
 *
 * 幂等：同一调用方应复用 runId；重复创建不会覆盖历史记录。
 */
export async function createAndExecuteRun(
  projectId: string,
  request: CreateRunInput,
  deps: RunServiceDeps = {},
): Promise<ResearchRun> {
  const project = await assertProjectAccess(projectId, loadProject)

  const { input, budget } = validateRunRequest(request)
  const frozenInput: RunInputManifest = { ...input, digest: digestInputManifest(input) }

  const runId = randomUUID()
  const logRel = `run-logs/${runId}.log`
  const now = new Date().toISOString()
  const run: ResearchRun = {
    id: runId,
    projectId,
    protocolVersion: request.protocolVersion,
    kind: request.kind,
    status: 'queued',
    title: request.title.trim(),
    input: frozenInput,
    budget,
    logRef: logRel,
    createdAt: now,
  }

  await appendEvent(projectId, {
    commandId: `run-${runId}`,
    payload: { type: 'run_recorded', run },
  })

  // 非计算运行：创建后即等待人工记录，不启动进程
  if (request.kind !== 'compute') {
    return run
  }

  const executor = deps.executor ?? new LocalRunExecutor()
  const projectRoot = deps.resolveProjectRoot?.(projectId) ?? defaultProjectRoot(projectId)

  await appendEvent(projectId, {
    commandId: `run-start-${randomUUID()}`,
    payload: { type: 'run_status_changed', runId, status: 'running' },
  })

  const logPath = join(getResearchDir(projectId), logRel)
  const controller = new AbortController()
  activeRuns.set(runId, controller)

  try {
    const result = await executor.execute(
      { runId, projectRoot, input: frozenInput, budget, logPath },
      controller.signal,
    )
    await appendEvent(projectId, {
      commandId: `run-finish-${randomUUID()}`,
      payload: {
        type: 'run_status_changed',
        runId,
        status: result.status,
        exitCode: result.exitCode,
        statusReason: result.statusReason,
        logRef: logRel,
      },
    })
  } catch (err) {
    await appendEvent(projectId, {
      commandId: `run-error-${randomUUID()}`,
      payload: {
        type: 'run_status_changed',
        runId,
        status: 'failed',
        statusReason: `执行器错误：${err instanceof Error ? err.message : String(err)}`,
        logRef: logRel,
      },
    })
  } finally {
    activeRuns.delete(runId)
  }

  void project
  const updated = (await listRuns(projectId)).find((r) => r.id === runId)!
  return updated
}

/** 运行中的取消控制器（MVP 单进程内存态；重启后遗留运行视为中断） */
const activeRuns = new Map<string, AbortController>()

/** 取消运行 */
export async function cancelRun(projectId: string, runId: string): Promise<ResearchRun> {
  await assertProjectAccess(projectId, loadProject)
  const runs = await listRuns(projectId)
  const run = runs.find((r) => r.id === runId)
  if (!run) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `运行记录不存在: ${runId}`)
  }
  if (['completed', 'failed', 'cancelled', 'timed-out'].includes(run.status)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `运行已结束（${run.status}），无法取消`)
  }

  const controller = activeRuns.get(runId)
  if (controller) {
    controller.abort()
    return (await listRuns(projectId)).find((r) => r.id === runId)!
  }

  // 无活跃控制器（未启动或已中断）：直接标记取消
  await appendEvent(projectId, {
    commandId: `run-cancel-${randomUUID()}`,
    payload: {
      type: 'run_status_changed',
      runId,
      status: 'cancelled',
      statusReason: '取消请求：未发现活跃进程（可能未启动或已中断）',
    },
  })
  return (await listRuns(projectId)).find((r) => r.id === runId)!
}

/** 登记手工观察（质性/现场研究的原始记录） */
export async function recordObservation(
  projectId: string,
  input: { runId: string; text: string },
): Promise<RunObservation> {
  await assertProjectAccess(projectId, loadProject)
  if (!input.text?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '观察内容不能为空')
  }
  const runs = await listRuns(projectId)
  const run = runs.find((r) => r.id === input.runId)
  if (!run) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `运行记录不存在: ${input.runId}`)
  }
  if (run.kind === 'compute') {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      '计算运行的输出在日志中，不使用观察登记；观察登记用于手工/现场记录',
    )
  }

  const observation: RunObservation = {
    id: randomUUID(),
    projectId,
    runId: input.runId,
    text: input.text.trim(),
    recordedBy: currentActor(),
    recordedAt: new Date().toISOString(),
  }
  await appendEvent(projectId, {
    commandId: `observation-${randomUUID()}`,
    payload: { type: 'observation_recorded', observation },
  })
  return observation
}

/**
 * 登记产物。
 *
 * 本地文件：解析到项目根内并计算 sha256 → integrity=verified。
 * 外部引用（doi:/dvc:/https:）：不下载、不算摘要 → integrity=unverified。
 */
export async function recordArtifact(
  projectId: string,
  input: { runId: string; ref: string; note?: string },
  deps: RunServiceDeps = {},
): Promise<RunArtifact> {
  await assertProjectAccess(projectId, loadProject)
  const runs = await listRuns(projectId)
  if (!runs.some((r) => r.id === input.runId)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `运行记录不存在: ${input.runId}`)
  }
  if (!input.ref?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '产物引用不能为空')
  }

  const ref = input.ref.trim()
  const kind = classifyArtifactRef(ref)
  let digest: string | undefined
  let sizeBytes: number | undefined

  if (kind === 'local-file') {
    const rootPath = deps.resolveProjectRoot?.(projectId) ?? defaultProjectRoot(projectId)
    const root = resolve(rootPath)
    const target = resolve(root, ref)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `产物路径超出项目目录: ${ref}`)
    }
    if (!existsSync(target)) {
      throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `产物文件不存在: ${ref}`)
    }
    // 符号链接校验：两侧都取 realpath，避免 macOS /var → /private/var 这类
    // 系统级链接造成误判，同时仍能阻断真正逃出项目目录的链接。
    const realTarget = realpathSync(target)
    const realRoot = existsSync(root) ? realpathSync(root) : root
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `产物经符号链接超出项目目录: ${ref}`)
    }
    const hashed = sha256File(realTarget)
    digest = hashed.digest
    sizeBytes = hashed.sizeBytes
  }

  const artifact: RunArtifact = {
    id: randomUUID(),
    projectId,
    runId: input.runId,
    ref,
    digest,
    sizeBytes,
    integrity: kind === 'local-file' ? 'verified' : 'unverified',
    note: input.note?.trim() || undefined,
    recordedAt: new Date().toISOString(),
  }

  await appendEvent(projectId, {
    commandId: `artifact-${randomUUID()}`,
    payload: { type: 'artifact_recorded', artifact },
  })
  return artifact
}

/** 运行日志的绝对路径（供 UI 读取） */
export function runLogPath(projectId: string, runId: string): string {
  return join(getResearchDir(projectId), 'run-logs', `${runId}.log`)
}
