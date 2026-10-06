/**
 * K2-02：受限 AOF adapter（主进程）。
 *
 * 通过固定 Python CLI（scripts/aof-bridge/cli.py）以 stdin/stdout JSON 帧
 * 调用本地 AOF bridge。安全约束：
 * - 只 spawn 固定解释器 + 固定脚本，不经 shell，不拼用户输入进命令行。
 * - 签名密钥仅经环境变量传给子进程，不出现在任何结果/日志中。
 * - 构建与查询超时；abort 传播；AOF 缺失时 disabled 而非抛错（基础检索
 *   不受影响——失败关闭语义路径）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface AofDoc {
  relative_path: string
  title: string
  content: string
  sha256: string
  links: string[]
}

export interface AofBuildResult {
  ok: true
  release_id: string
  release_digest: string
  ledger: Record<string, unknown>
}

export interface AofQueryHit {
  resource_id: string
  name: string
  kind: string
}

export interface AofAdapterOptions {
  /** AOF 仓库根（默认 ~/LLM/AOF） */
  aofRoot?: string
  /** AOF .venv python 路径（测试可注入假解释器） */
  pythonPath?: string
  /** cli.py 路径（测试可注入） */
  cliPath?: string
  /** AOF 状态目录 */
  stateDir: string
  /** 构建超时 ms（默认 120s） */
  buildTimeoutMs?: number
  /** 查询超时 ms（默认 10s） */
  queryTimeoutMs?: number
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type AofState =
  | { kind: 'disabled'; reason: string }
  | { kind: 'ready' }

export class KnowledgeAofAdapter {
  private readonly opts: Required<Pick<AofAdapterOptions, 'buildTimeoutMs' | 'queryTimeoutMs'>> & AofAdapterOptions
  private proc: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, PendingRequest>()
  private state: AofState
  private readonly secret: string

  constructor(options: AofAdapterOptions) {
    this.opts = {
      buildTimeoutMs: options.buildTimeoutMs ?? 120_000,
      queryTimeoutMs: options.queryTimeoutMs ?? 10_000,
      ...options,
    }
    this.secret = `aof-bridge:${randomUUID()}:${randomUUID()}`
    this.state = this.detectEnvironment()
  }

  private detectEnvironment(): AofState {
    const aofRoot = this.opts.aofRoot ?? join(process.env.HOME ?? '', 'LLM', 'AOF')
    const python = this.opts.pythonPath ?? join(aofRoot, '.venv', 'bin', 'python')
    const cli = this.opts.cliPath ?? '' // 由调用方在 initialize 时提供或用默认
    if (!existsSync(python)) {
      return { kind: 'disabled', reason: `AOF python 不存在: ${python}` }
    }
    if (cli && !existsSync(cli)) {
      return { kind: 'disabled', reason: `AOF bridge CLI 不存在: ${cli}` }
    }
    return { kind: 'ready' }
  }

  get disabled(): { reason: string } | null {
    return this.state.kind === 'disabled' ? { reason: this.state.reason } : null
  }

  /** 惰性启动子进程；JSON-Lines 帧协议。 */
  private async ensureProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (this.proc) return this.proc
    if (this.state.kind === 'disabled') throw new Error(`AOF adapter 不可用: ${this.state.reason}`)
    const aofRoot = this.opts.aofRoot ?? join(process.env.HOME ?? '', 'LLM', 'AOF')
    const python = this.opts.pythonPath ?? join(aofRoot, '.venv', 'bin', 'python')
    const cli = this.opts.cliPath ?? join(process.cwd(), 'scripts', 'aof-bridge', 'cli.py')
    const child = spawn(python, [cli, '--state-dir', this.opts.stateDir, '--aof-root', aofRoot], {
      env: { ...process.env, AOF_BRIDGE_SECRET: this.secret },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams

    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        return // 非 JSON 输出忽略（诊断走 stderr）
      }
      const id = typeof msg.request_id === 'string' ? msg.request_id : null
      if (!id) return
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.resolve(msg)
    })
    child.stderr.on('data', () => { /* 诊断日志：不回显密钥 */ })
    child.on('exit', () => {
      this.proc = null
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error(`AOF bridge 子进程退出，请求 ${id} 未完成`))
      }
      this.pending.clear()
    })
    this.proc = child
    return child
  }

  private async request(op: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const child = await this.ensureProcess()
    const request_id = randomUUID()
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id)
        reject(new Error(`AOF ${op} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(request_id, { resolve, reject, timer })
    })
    child.stdin.write(`${JSON.stringify({ op, request_id, ...payload })}\n`)
    return promise
  }

  async health(): Promise<{ available: boolean; reason?: string }> {
    if (this.state.kind === 'disabled') return { available: false, reason: this.state.reason }
    try {
      const res = await this.request('health', {}, 5_000)
      return res.ok === true ? { available: true } : { available: false, reason: JSON.stringify(res.error) }
    } catch (err) {
      return { available: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 构建 + 发布 + promote；返回 release 信息与台账。 */
  async buildAndPublish(kbId: string, docs: AofDoc[]): Promise<AofBuildResult> {
    const res = await this.request('build', { kb_id: kbId, docs }, this.opts.buildTimeoutMs)
    if (res.ok !== true) {
      const err = res.error as { type?: string; message?: string } | undefined
      throw new Error(`AOF 构建失败: ${err?.type ?? 'Unknown'} ${err?.message ?? ''}`)
    }
    return {
      ok: true,
      release_id: String(res.release_id),
      release_digest: String(res.release_digest),
      ledger: (res.ledger ?? {}) as Record<string, unknown>,
    }
  }

  /** release-pinned 语义查询；digest 不匹配时 AOF 拒绝。 */
  async semanticQuery(query: string, opts: { limit?: number; expectedReleaseDigest?: string } = {}): Promise<AofQueryHit[]> {
    const res = await this.request('query', {
      query,
      limit: opts.limit ?? 5,
      ...(opts.expectedReleaseDigest ? { expected_release_digest: opts.expectedReleaseDigest } : {}),
    }, this.opts.queryTimeoutMs)
    if (res.ok !== true) {
      const err = res.error as { type?: string; message?: string } | undefined
      throw new Error(`AOF 查询失败: ${err?.type ?? 'Unknown'} ${err?.message ?? ''}`)
    }
    return (res.hits ?? []) as AofQueryHit[]
  }

  /** 中止所有未完成请求并终止子进程。 */
  stop(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('AOF adapter 已停止'))
    }
    this.pending.clear()
    this.proc?.kill()
    this.proc = null
  }
}
