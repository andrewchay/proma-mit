/**
 * Bash 命令的进程树终止与可核验证据。
 *
 * 停止会话时仅"请求中止"不等于进程已退出：execFile 只能杀掉直接子进程，
 * 命令内部的后台子进程会存活。这里以独立进程组启动命令，终止对整个进程组下发
 * SIGTERM，超期再 SIGKILL，并用 `kill(-pgid, 0)` 探测进程组是否真的消失——
 * 探测不到消失就标记 unconfirmed，不把信号请求当成终止事实。
 */

import { spawn } from 'node:child_process'
import { formatToolError } from './tool-utils.ts'

/** 单条输出流的上限，超出部分丢弃（工具层还有面向模型的截断）。 */
const MAX_STREAM_BYTES = 4 * 1024 * 1024
/** SIGTERM 后等待进程组退出的宽限期。 */
const TERM_GRACE_MS = 1500
/** SIGKILL 后等待进程组退出的宽限期。 */
const KILL_GRACE_MS = 1000
/** 正常退出后确认进程组为空的等待上限（容忍正在退出的成员）。 */
const SETTLE_MS = 400

export interface BashTerminationEvidence {
  /** 触发终止的来源：命令自己结束、会话中止、超时。 */
  requestedBy: 'completion' | 'abort' | 'timeout'
  /** 子进程 pid，同时也是进程组 id（detached 启动）。 */
  pgid: number
  /** 实际下发过的信号及时间戳。 */
  signals: { signal: NodeJS.Signals; at: number }[]
  /** 探测时进程组是否仍有成员存活；探测本身失败时记为 true（未知按未终止处理）。 */
  groupAlive: boolean
  /** exited：自行退出且进程组已空；terminated：信号后进程组已空；unconfirmed：未确认。 */
  status: 'exited' | 'terminated' | 'unconfirmed'
  exitCode: number | null
  exitSignal: string | null
  durationMs: number
}

export interface RunBashInput {
  /** 完整 argv，例如 [sandbox-exec, -p, profile, /bin/sh, -c, command]。 */
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
  abortSignal?: AbortSignal
}

export interface RunBashResult {
  stdout: string
  stderr: string
  evidence: BashTerminationEvidence
  /** 失败信息（超时、中止、启动错误）；成功时为 undefined。 */
  failure?: { message: string; isError: true }
}

/** 探测进程组是否仍有成员：ESRCH 表示已空，其他错误按"未知存活"处理。 */
function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** 轮询等待进程组消失，返回是否已消失。 */
async function waitForGroupGone(pgid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!isGroupAlive(pgid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !isGroupAlive(pgid)
}

/**
 * 执行沙箱命令并维护终止证据。
 *
 * 以 detached 启动使子进程自成进程组，终止时对整组发信号，因此命令内部
 * `cmd &` 产生的后代不会被遗留。SIGTERM 宽限期后仍存活则升级 SIGKILL。
 */
export async function runBashCommand(input: RunBashInput): Promise<RunBashResult> {
  const startedAt = Date.now()
  const [file, ...args] = input.argv
  if (!file) throw new Error('沙箱 argv 为空')
  const child = spawn(file, args, {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pgid = child.pid
  if (!pgid) {
    return {
      stdout: '',
      stderr: '',
      evidence: {
        requestedBy: 'completion',
        pgid: -1,
        signals: [],
        groupAlive: false,
        status: 'unconfirmed',
        exitCode: null,
        exitSignal: null,
        durationMs: Date.now() - startedAt,
      },
      failure: { message: '无法启动沙箱进程', isError: true },
    }
  }

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdout.length < MAX_STREAM_BYTES) stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < MAX_STREAM_BYTES) stderr += chunk.toString('utf8')
  })

  const signals: { signal: NodeJS.Signals; at: number }[] = []
  // 用对象持有状态：闭包内的赋值不会被类型收窄当成"永远是 completion"。
  const state: { requestedBy: BashTerminationEvidence['requestedBy']; terminating: boolean } = {
    requestedBy: 'completion',
    terminating: false,
  }

  const send = (signal: NodeJS.Signals) => {
    signals.push({ signal, at: Date.now() - startedAt })
    try {
      process.kill(-pgid, signal)
    } catch {
      // 组已消失时下发失败属正常收敛，记录信号即可。
    }
  }

  const terminate = async (reason: 'abort' | 'timeout') => {
    if (state.terminating) return
    state.terminating = true
    state.requestedBy = reason
    send('SIGTERM')
    if (await waitForGroupGone(pgid, TERM_GRACE_MS)) return
    send('SIGKILL')
    await waitForGroupGone(pgid, KILL_GRACE_MS)
  }

  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: unknown }>((resolve) => {
    const timer = setTimeout(() => {
      void terminate('timeout')
    }, input.timeout)
    const onAbort = () => {
      void terminate('abort')
    }
    const signal = input.abortSignal
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    child.once('error', (error) => {
      cleanup()
      resolve({ code: null, signal: null, error })
    })
    child.once('exit', (code, exitSignal) => {
      cleanup()
      resolve({ code, signal: exitSignal })
    })
  })

  // 自行退出后也确认进程组为空：命令留下的后台子进程不能被当成"已终止"。
  const groupGone = await waitForGroupGone(pgid, SETTLE_MS)
  const status: BashTerminationEvidence['status'] = !groupGone
    ? 'unconfirmed'
    : state.terminating
      ? 'terminated'
      : 'exited'
  const evidence: BashTerminationEvidence = {
    requestedBy: state.requestedBy,
    pgid,
    signals,
    groupAlive: !groupGone,
    status,
    exitCode: outcome.code,
    exitSignal: outcome.signal,
    durationMs: Date.now() - startedAt,
  }

  let failure: RunBashResult['failure']
  if (outcome.error) failure = { message: formatToolError(outcome.error), isError: true }
  else if (state.requestedBy === 'timeout') failure = { message: `${withStderr(`命令超时（${input.timeout}ms）`, stderr)}`, isError: true }
  else if (state.requestedBy === 'abort') failure = { message: withStderr('命令已中止', stderr), isError: true }
  // 非零退出沿用 execFile 的语义：工具调用失败（isError），并把 stderr 带出去供排查。
  else if (typeof outcome.code === 'number' && outcome.code !== 0) {
    failure = { message: withStderr(`命令退出码 ${outcome.code}`, stderr), isError: true }
  } else if (outcome.signal) {
    failure = { message: withStderr(`命令被信号 ${outcome.signal} 终止`, stderr), isError: true }
  }

  return { stdout, stderr, evidence, failure }
}

/** 失败信息带上 stderr（截断），避免非零退出时丢失诊断线索。 */
function withStderr(message: string, stderr: string): string {
  const trimmed = stderr.trim()
  if (!trimmed) return message
  return `${message}\n${trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed}`
}

/** 生成面向用户/审计的终止证据说明；正常结束且进程组已空时返回 undefined（不产生噪音）。 */
export function describeBashTermination(evidence: BashTerminationEvidence): string | undefined {
  const signalChain = evidence.signals.map((item) => item.signal).join('→')
  if (evidence.status === 'exited') return undefined
  if (evidence.status === 'terminated') {
    return `已按${evidence.requestedBy === 'abort' ? '会话中止' : '超时'}终止命令（${signalChain || '无信号'}），进程组 ${evidence.pgid} 已确认退出`
  }
  const reason = evidence.requestedBy === 'completion' ? '命令已结束但仍有后台进程存活' : `${signalChain || '无信号'}后仍有进程存活`
  return `⚠️ 终止未确认：${reason}，进程组 ${evidence.pgid} 不能视为已终止`
}
