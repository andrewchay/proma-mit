/**
 * V03 固定基线验证器。
 *
 * 只从已提交 commit 通过 `git archive` 导出干净副本执行受保护命令：
 * - 不读取工作树未提交改动，也不读取 .gitignore 产生的本地文件；
 * - argv 数组直接 spawn，不经 shell；仅 `{{JUNIT_REPORT}}` 占位符会被替换为主进程临时报告路径；
 * - 结果由主进程解析 JUnit 根节点计数判定，不依赖 stdout 中的 PASS 字样。
 *
 * 边界：依赖安装、宿主机环境与被测代码本身仍可能有副作用；本模块只保证“测的是该 commit 的内容”。
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const JUNIT_REPORT_PLACEHOLDER = '{{JUNIT_REPORT}}'
const MAX_TIMEOUT_MS = 30 * 60_000

export interface PinnedVerifierConfig {
  readonly version: 1
  readonly verifierId: string
  /** 完整 argv；首项为可执行文件，不经 shell 解释。 */
  readonly argv: readonly string[]
  readonly expectedExitCodes: readonly number[]
  readonly timeoutMs: number
  /** 至少要采集到的测试数量；零测试不得通过。 */
  readonly minimumTests: number
}

export interface PinnedVerifierRequest {
  readonly repoRoot: string
  readonly commitSha: string
  readonly config: PinnedVerifierConfig
}

export type PinnedVerifierReason =
  | 'exit_code_unexpected'
  | 'timeout'
  | 'collection_missing'
  | 'too_few_tests'
  | 'test_failures'
  | 'spawn_error'

export interface PinnedVerifierReceipt {
  readonly version: 1
  readonly verifierId: string
  readonly commitSha: string
  readonly argvSha256: string
  readonly cleanCheckout: true
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly tests: number
  readonly failures: number
  readonly errors: number
  readonly skipped: number
  readonly verdict: 'passed' | 'failed' | 'unknown'
  readonly reasons: readonly PinnedVerifierReason[]
  readonly cleanedUp: boolean
  readonly startedAt: string
  readonly finishedAt: string
}

export interface JUnitTotals {
  readonly tests: number
  readonly failures: number
  readonly errors: number
  readonly skipped: number
}

function assertCommit(sha: string): void {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('commit 必须是完整的 40 位小写十六进制 SHA')
}

function validateConfig(config: PinnedVerifierConfig): void {
  if (config.version !== 1) throw new Error('verifier config version 必须为 1')
  if (!config.verifierId.trim()) throw new Error('verifierId 不能为空')
  if (config.argv.length === 0 || config.argv.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error('argv 必须是非空字符串数组')
  }
  if (config.expectedExitCodes.length === 0 || config.expectedExitCodes.some((code) => !Number.isInteger(code))) {
    throw new Error('expectedExitCodes 必须是非空整数数组')
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error('timeoutMs 必须在 1 到 1800000 之间')
  }
  if (!Number.isInteger(config.minimumTests) || config.minimumTests < 1) {
    throw new Error('minimumTests 必须为不小于 1 的整数')
  }
}

function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '' },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, timedOut, error: error.message })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, timedOut })
    })
  })
}

/** 解析 JUnit 根节点计数；缺少根节点或数字非法时返回 null，由调用方判为采集失败。 */
export function parseJUnitTotals(xml: string): JUnitTotals | null {
  const root = /<testsuites\b([^>]*)>/.exec(xml) ?? /<testsuite\b([^>]*)>/.exec(xml)
  if (!root) return null
  const attr = (name: string): number | undefined => {
    const match = new RegExp(`\\b${name}="(\\d+)"`).exec(root[1] ?? '')
    return match ? Number(match[1]) : undefined
  }
  const tests = attr('tests')
  const failures = attr('failures')
  if (tests === undefined || failures === undefined) return null
  return { tests, failures, errors: attr('errors') ?? 0, skipped: attr('skipped') ?? 0 }
}

/** 固定基线验证：导出 commit 到临时目录，执行受保护 argv，并从报告计数判定。 */
export async function runPinnedBaselineVerifier(request: PinnedVerifierRequest): Promise<PinnedVerifierReceipt> {
  assertCommit(request.commitSha)
  validateConfig(request.config)
  const startedAt = new Date().toISOString()
  const argvSha256 = createHash('sha256').update(JSON.stringify(request.config.argv)).digest('hex')
  const workRoot = await mkdtemp(join(tmpdir(), 'gravitas-pinned-'))
  const checkout = join(workRoot, 'checkout')
  const reportDir = join(workRoot, 'report')
  const reportPath = join(reportDir, `${randomUUID()}.xml`)
  const archivePath = join(workRoot, 'source.tar')
  let receipt: PinnedVerifierReceipt | undefined
  try {
    await mkdir(checkout)
    await mkdir(reportDir)
    // 只导出 Git 对象中的 commit 内容；工作树未提交文件与 ignored 文件均不进入副本。
    const archived = await runProcess('git', ['-C', request.repoRoot, 'archive', '--format=tar', '-o', archivePath, request.commitSha], { cwd: workRoot, timeoutMs: 120_000 })
    if (archived.code !== 0) throw new Error(`git archive 失败：${archived.error ?? `退出码 ${archived.code}`}`)
    const extracted = await runProcess('tar', ['-xf', archivePath, '-C', checkout], { cwd: workRoot, timeoutMs: 120_000 })
    if (extracted.code !== 0) throw new Error(`解包 commit 失败：${extracted.error ?? `退出码 ${extracted.code}`}`)

    const argv = request.config.argv.map((item) => item.split(JUNIT_REPORT_PLACEHOLDER).join(reportPath))
    const [command, ...args] = argv as [string, ...string[]]
    const run = await runProcess(command, args, { cwd: checkout, timeoutMs: request.config.timeoutMs })

    const reasons: PinnedVerifierReason[] = []
    if (run.error) reasons.push('spawn_error')
    if (run.timedOut) reasons.push('timeout')
    if (run.code === null || !request.config.expectedExitCodes.includes(run.code)) reasons.push('exit_code_unexpected')

    let totals: JUnitTotals | null = null
    try {
      totals = parseJUnitTotals(await readFile(reportPath, 'utf8'))
    } catch {
      totals = null
    }
    if (!totals) {
      reasons.push('collection_missing')
    } else {
      if (totals.tests < request.config.minimumTests) reasons.push('too_few_tests')
      if (totals.failures + totals.errors > 0) reasons.push('test_failures')
    }
    const finishedAt = new Date().toISOString()
    // 只有无法启动进程时才是 unknown；其余任何失败原因都计为 failed，未知结果不计成功。
    const verdict = reasons.length === 0 ? 'passed' : reasons.includes('spawn_error') ? 'unknown' : 'failed'
    receipt = {
      version: 1,
      verifierId: request.config.verifierId,
      commitSha: request.commitSha,
      argvSha256,
      cleanCheckout: true,
      exitCode: run.code,
      timedOut: run.timedOut,
      tests: totals?.tests ?? 0,
      failures: totals?.failures ?? 0,
      errors: totals?.errors ?? 0,
      skipped: totals?.skipped ?? 0,
      verdict,
      reasons,
      cleanedUp: false,
      startedAt,
      finishedAt,
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
  if (!receipt) throw new Error('验证器未生成回执')
  return { ...receipt, cleanedUp: true }
}
