/**
 * OpenResearch (orx) adapter（M6.2）
 *
 * 约束与诚实边界：
 * - **不内置 orx**：需用户自行安装；未安装时给出可读错误，不伪造结果
 * - 调用一律走受限 execFile（无 shell、超时、参数数组）
 * - **字段映射基于核实过的上游表结构**（local_projects / runs 的列名：
 *   id / name / slug / baseline_branch / run_command；runs 的
 *   id / experiment_id / project_id / status / command / exit_code /
 *   created_at / ended_at / commit_sha）。上游若变更 schema，
 *   解析会降级为「字段缺失」而不是崩溃——**真机联调前不得声称已验收**。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'

const execFileAsync = promisify(execFile)

/** orx 调用的超时（毫秒）：只读查询，不应长跑 */
const ORX_TIMEOUT_MS = 30_000
/** 单次返回字节上限保护（防止巨量 JSON 灌入内存） */
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024

/** 注入式 exec（测试用）：返回 stdout */
export type ExecFn = (binary: string, args: string[], options: { timeoutMs: number }) => Promise<string>

export const defaultExec: ExecFn = async (binary, args, options) => {
  const { stdout } = await execFileAsync(binary, args, {
    timeout: options.timeoutMs,
    shell: false,
    windowsHide: true,
    maxBuffer: MAX_OUTPUT_CHARS,
  })
  return stdout
}

/** orx 项目（映射自 local_projects） */
export interface OrxProject {
  id: string
  name?: string
  slug?: string
  baselineBranch?: string
  runCommand?: string
  repoPath?: string
}

/** orx 运行（映射自 runs） */
export interface OrxRun {
  id: string
  projectId?: string
  experimentId?: string
  status?: string
  command?: string
  exitCode?: number
  createdAt?: number
  endedAt?: number
  commitSha?: string
}

function assertOrxNotMissing(err: unknown, action: string): never {
  const code = (err as { code?: string | number }).code
  if (code === 'ENOENT') {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `未检测到 orx CLI：无法${action}。请先自行安装 OpenResearch（https://github.com/alphaXiv/OpenResearch）`,
    )
  }
  throw new ResearchError(
    RESEARCH_ERROR_CODES.INVALID_INPUT,
    `orx ${action}失败：${err instanceof Error ? err.message : String(err)}`,
  )
}

/** 宽松 JSON 解析：接受数组或 {items|projects|runs: []} 包装 */
function extractArray(raw: string, keys: string[]): unknown[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `orx 输出不是合法 JSON（可能上游版本改用了其他格式）：${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    for (const key of keys) {
      const candidate = (parsed as Record<string, unknown>)[key]
      if (Array.isArray(candidate)) return candidate
    }
  }
  return []
}

/** camelCase 与 snake_case 两种键都接受（上游 JSON 序列化风格可能不同） */
function pick<T>(source: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null) return value as T
  }
  return undefined
}

export function mapOrxProject(raw: Record<string, unknown>): OrxProject | null {
  const id = pick<string>(raw, 'id', 'project_id')
  if (!id) return null
  return {
    id,
    name: pick<string>(raw, 'name'),
    slug: pick<string>(raw, 'slug'),
    baselineBranch: pick<string>(raw, 'baselineBranch', 'baseline_branch'),
    runCommand: pick<string>(raw, 'runCommand', 'run_command'),
    repoPath: pick<string>(raw, 'repoPath', 'repo_path'),
  }
}

export function mapOrxRun(raw: Record<string, unknown>): OrxRun | null {
  const id = pick<string>(raw, 'id', 'run_id')
  if (!id) return null
  const exitCode = pick<number>(raw, 'exitCode', 'exit_code')
  return {
    id,
    projectId: pick<string>(raw, 'projectId', 'project_id'),
    experimentId: pick<string>(raw, 'experimentId', 'experiment_id'),
    status: pick<string>(raw, 'status'),
    command: pick<string>(raw, 'command'),
    exitCode: typeof exitCode === 'number' ? exitCode : undefined,
    createdAt: pick<number>(raw, 'createdAt', 'created_at'),
    endedAt: pick<number>(raw, 'endedAt', 'ended_at'),
    commitSha: pick<string>(raw, 'commitSha', 'commit_sha'),
  }
}

export interface OpenResearchAdapter {
  probe(): Promise<{ installed: boolean; version?: string }>
  listProjects(): Promise<OrxProject[]>
  listRuns(projectId: string): Promise<OrxRun[]>
  readRunLog(runId: string): Promise<string>
}

export function createOpenResearchAdapter(exec: ExecFn = defaultExec): OpenResearchAdapter {
  return {
    async probe() {
      try {
        const stdout = await exec('orx', ['--version'], { timeoutMs: 5000 })
        const match = stdout.match(/\d+\.\d+(\.\d+)?/)
        return { installed: true, version: match?.[0] }
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') return { installed: false }
        return { installed: false }
      }
    },

    async listProjects() {
      let stdout: string
      try {
        stdout = await exec('orx', ['projects', '--json'], { timeoutMs: ORX_TIMEOUT_MS })
      } catch (err) {
        assertOrxNotMissing(err, '列出项目')
      }
      return extractArray(stdout, ['items', 'projects'])
        .map((item) => mapOrxProject(item as Record<string, unknown>))
        .filter((p): p is OrxProject => p !== null)
    },

    async listRuns(projectId: string) {
      let stdout: string
      try {
        stdout = await exec('orx', ['runs', projectId, '--json'], { timeoutMs: ORX_TIMEOUT_MS })
      } catch (err) {
        assertOrxNotMissing(err, '列出运行')
      }
      return extractArray(stdout, ['items', 'runs'])
        .map((item) => mapOrxRun(item as Record<string, unknown>))
        .filter((r): r is OrxRun => r !== null)
    },

    async readRunLog(runId: string) {
      try {
        // --bytes 限制返回量，避免把超长日志整段拉进内存
        return await exec('orx', ['logs', runId, '--bytes', '262144'], { timeoutMs: ORX_TIMEOUT_MS })
      } catch (err) {
        assertOrxNotMissing(err, '读取运行日志')
      }
    },
  }
}

/**
 * 外部运行状态归一化：把 orx 的 status 映射到本插件的运行状态。
 *
 * 无法识别的状态归为 failed 并保留原始值（不猜测为 completed）。
 */
export function normalizeOrxStatus(status: string | undefined, exitCode?: number): {
  status: 'completed' | 'failed' | 'running' | 'queued' | 'cancelled'
  unmappedRaw?: string
} {
  const s = status?.toLowerCase()
  switch (s) {
    case 'done':
    case 'completed':
    case 'succeeded':
      return { status: 'completed' }
    case 'failed':
    case 'error':
      return { status: 'failed' }
    case 'running':
    case 'starting':
      return { status: 'running' }
    case 'queued':
    case 'pending':
      return { status: 'queued' }
    case 'cancelled':
    case 'canceled':
      return { status: 'cancelled' }
    default:
      // 未知状态：有退出码时按退出码判断，否则保守标 failed 并保留原值
      if (typeof exitCode === 'number') {
        return { status: exitCode === 0 ? 'completed' : 'failed', unmappedRaw: status }
      }
      return { status: 'failed', unmappedRaw: status }
  }
}
