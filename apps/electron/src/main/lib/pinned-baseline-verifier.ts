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
import { isAbsolute, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { getConfigDir } from './config-paths'
import { wrapWithSeatbelt } from './pinned-verifier-sandbox'
import type { PinnedVerifierConfig, PinnedVerifierReason, PinnedVerifierReceipt } from '@gravitas/shared'

export type { PinnedVerifierConfig, PinnedVerifierReason, PinnedVerifierReceipt }

export const JUNIT_REPORT_PLACEHOLDER = '{{JUNIT_REPORT}}'
const MAX_TIMEOUT_MS = 30 * 60_000

export interface PinnedVerifierRequest {
  readonly repoRoot: string
  readonly commitSha: string
  readonly config: PinnedVerifierConfig
  /** 测试注入；默认 process.platform。非 darwin 无隔离，直接 unknown。 */
  readonly platform?: NodeJS.Platform
  /** 显式拒绝读写的目录（默认：应用配置目录，含签名密钥与已签名记录）。 */
  readonly protectedDirs?: readonly string[]
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
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

/** 校验受保护验证配置；非法配置在执行前拒绝。 */
export function validatePinnedVerifierConfig(config: PinnedVerifierConfig): void {
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

/** 解析仓库 HEAD 的完整提交 SHA；未提交内容不会被纳入。 */
export async function resolveHeadCommitSha(repoRoot: string): Promise<string> {
  if (!isAbsolute(repoRoot)) throw new Error('repoRoot 必须是绝对路径')
  const sha = await new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD^{commit}'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error('无法解析仓库 HEAD 提交'))))
  })
  assertCommit(sha)
  return sha
}

/** 固定基线验证：导出 commit 到临时目录，执行受保护 argv，并从报告计数判定。 */
export async function runPinnedBaselineVerifier(request: PinnedVerifierRequest): Promise<PinnedVerifierReceipt> {
  assertCommit(request.commitSha)
  validatePinnedVerifierConfig(request.config)
  const startedAt = new Date().toISOString()
  const argvSha256 = createHash('sha256').update(JSON.stringify(request.config.argv)).digest('hex')
  const platform = request.platform ?? process.platform
  if (platform !== 'darwin') {
    // 无隔离时不执行受保护命令：unknown 不计成功。
    const at = new Date().toISOString()
    return {
      version: 1, verifierId: request.config.verifierId, commitSha: request.commitSha, argvSha256,
      cleanCheckout: true, isolation: 'unavailable', exitCode: null, timedOut: false,
      tests: 0, failures: 0, errors: 0, skipped: 0, verdict: 'unknown', reasons: ['sandbox_unavailable'],
      cleanedUp: true, startedAt, finishedAt: at,
    }
  }
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
    // seatbelt：只允许写工作目录与用户临时目录；配置目录读写一律拒绝。
    const sandboxed = wrapWithSeatbelt(argv, {
      writableRoots: [realOrSelf(workRoot), realOrSelf(tmpdir())],
      denyRoots: (request.protectedDirs ?? [getConfigDir()]).map(realOrSelf),
    })
    const [command, ...args] = sandboxed as [string, ...string[]]
    const run = await runProcess(command, args, { cwd: checkout, timeoutMs: request.config.timeoutMs })

    const reasons: PinnedVerifierReason[] = []
    if (run.error) reasons.push('spawn_error')
    if (run.timedOut) reasons.push('timeout')
    if (run.code === null || !request.config.expectedExitCodes.includes(run.code)) reasons.push('exit_code_unexpected')

    let totals: JUnitTotals | null = null
    let reportSha256: string | undefined
    let reportBytes: number | undefined
    try {
      // 可信采集：以字节级哈希绑定回执与实际解析的报告内容（B03），
      // 同计数伪造报告无法复现哈希。
      const reportBuffer = await readFile(reportPath)
      reportBytes = reportBuffer.byteLength
      reportSha256 = createHash('sha256').update(reportBuffer).digest('hex')
      totals = parseJUnitTotals(reportBuffer.toString('utf8'))
    } catch {
      totals = null
      reportSha256 = undefined
      reportBytes = undefined
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
      isolation: 'seatbelt-macos',
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
      ...(reportSha256 !== undefined && reportBytes !== undefined ? { reportSha256, reportBytes } : {}),
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
  if (!receipt) throw new Error('验证器未生成回执')
  return { ...receipt, cleanedUp: true }
}
