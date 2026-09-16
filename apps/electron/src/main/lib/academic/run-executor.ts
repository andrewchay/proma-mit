/**
 * 受限本地运行执行器（M4）
 *
 * 安全约束（方案 §11.3）——这些是硬边界，不是风格偏好：
 * 1. **不经过 shell**：`spawn(interpreter, [script, ...args])`，参数数组传递，
 *    绝不拼接命令行字符串。因此 `;`、`&&`、`$(...)`、反引号都没有意义。
 * 2. **cwd 限定在项目目录内**：脚本相对项目根解析，且解析后必须仍在根内
 *    （阻断符号链接/`..` 逃逸）。
 * 3. **解释器白名单**：由 run-rules 校验，本层再确认一次。
 * 4. **超时与输出上限**：超时杀进程；输出超出上限截断并标记。
 * 5. **环境最小化**：只透传 PATH/HOME/LANG/TZ 等必要变量，不注入应用密钥。
 *
 * 本模块可以被注入替代实现（测试用），服务层只依赖 RunExecutor 接口。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { ALLOWED_INTERPRETERS } from '@gravitas/core/services/academic'
import type { RunBudget, RunInputManifest } from '@gravitas/shared'

export interface RunExecutionRequest {
  runId: string
  projectRoot: string
  input: RunInputManifest
  budget: RunBudget
  /** 日志文件绝对路径 */
  logPath: string
}

export interface RunExecutionResult {
  status: 'completed' | 'failed' | 'timed-out' | 'cancelled'
  exitCode?: number
  /** 归一化原因（不含原始 stderr 正文，避免把敏感内容写进事件流） */
  statusReason?: string
  /** 输出是否被截断 */
  outputTruncated: boolean
  /** 日志字节数 */
  logBytes: number
  /** 日志文件 sha256（产物完整性） */
  logDigest?: string
}

export interface RunExecutor {
  /** 执行一次运行；实现方保证超时与输出上限生效 */
  execute(request: RunExecutionRequest, signal: AbortSignal): Promise<RunExecutionResult>
}

/** 校验脚本路径确实位于项目根内（解析后比对，阻断符号链接逃逸） */
export function resolveScriptInsideRoot(projectRoot: string, scriptPath: string): string {
  if (isAbsolute(scriptPath)) {
    throw new Error(`不允许绝对路径脚本: ${scriptPath}`)
  }
  const root = resolve(projectRoot)
  const target = resolve(root, scriptPath)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`脚本超出项目目录: ${scriptPath}`)
  }
  // 已存在时用 realpath 再校验一次（符号链接逃逸）
  if (existsSync(target)) {
    const realTarget = realpathSync(target)
    const realRoot = existsSync(root) ? realpathSync(root) : root
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new Error(`脚本经符号链接超出项目目录: ${scriptPath}`)
    }
    if (!statSync(realTarget).isFile()) {
      throw new Error(`脚本不是普通文件: ${scriptPath}`)
    }
  }
  return target
}

/** 允许的解释器清单（供 UI/IPC 只读展示，与核心规则同源） */
export const ALLOWED_INTERPRETER_LIST: readonly string[] = ALLOWED_INTERPRETERS

/** 最小化子进程环境：不注入应用密钥，仅保留运行必需变量 */
export function minimalEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SystemRoot', 'USERPROFILE']
  const env: NodeJS.ProcessEnv = {}
  for (const key of keep) {
    if (source[key] !== undefined) env[key] = source[key]
  }
  return env
}

/** 真实本地执行器 */
export class LocalRunExecutor implements RunExecutor {
  async execute(request: RunExecutionRequest, signal: AbortSignal): Promise<RunExecutionResult> {
    const { input, budget } = request
    const interpreter = input.interpreter!
    if (!ALLOWED_INTERPRETERS.includes(interpreter as (typeof ALLOWED_INTERPRETERS)[number])) {
      throw new Error(`不允许的解释器: ${interpreter}`)
    }

    const root = resolve(request.projectRoot)
    if (!existsSync(root)) {
      throw new Error(`项目目录不存在: ${root}`)
    }
    const scriptAbs = resolveScriptInsideRoot(root, input.scriptPath!)

    mkdirSync(dirname(request.logPath), { recursive: true })
    const logStream = createWriteStream(request.logPath, { flags: 'a' })
    const hash = createHash('sha256')
    let written = 0
    let truncated = false

    const child = spawn(interpreter, [scriptAbs, ...(input.args ?? [])], {
      cwd: root,
      env: minimalEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      // 不用 shell: true —— 这是本执行器的关键安全属性
      shell: false,
    })

    const writeChunk = (chunk: Buffer) => {
      const remaining = budget.maxOutputBytes - written
      if (remaining <= 0) {
        truncated = true
        return
      }
      const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
      if (slice.byteLength < chunk.byteLength) truncated = true
      hash.update(slice)
      written += slice.byteLength
      logStream.write(slice)
    }

    child.stdout.on('data', writeChunk)
    child.stderr.on('data', writeChunk)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, budget.timeoutMs)

    const abortHandler = () => child.kill('SIGTERM')
    signal.addEventListener('abort', abortHandler, { once: true })

    const exitCode: number | null = await new Promise((resolveExit) => {
      child.on('error', (err) => {
        writeChunk(Buffer.from(`\n[执行器] 进程启动失败: ${err.message}\n`, 'utf8'))
        resolveExit(-1)
      })
      child.on('close', (code) => resolveExit(code))
    })

    clearTimeout(timer)
    signal.removeEventListener('abort', abortHandler)
    await new Promise<void>((done) => logStream.end(() => done()))

    const logBytes = written
    let logDigest: string | undefined
    try {
      logDigest = createHash('sha256').update(readFileSync(request.logPath)).digest('hex')
    } catch {
      // 日志读取失败不影响运行结论，仅缺摘要
    }

    if (timedOut) {
      return {
        status: 'timed-out',
        exitCode: exitCode ?? undefined,
        statusReason: `超过预算超时 ${budget.timeoutMs} ms，进程已被终止`,
        outputTruncated: truncated,
        logBytes,
        logDigest,
      }
    }
    if (signal.aborted) {
      return { status: 'cancelled', exitCode: exitCode ?? undefined, statusReason: '运行被取消', outputTruncated: truncated, logBytes, logDigest }
    }
    if (exitCode === 0) {
      return {
        status: 'completed',
        exitCode: 0,
        statusReason: truncated ? '进程正常结束；输出超过上限已截断' : undefined,
        outputTruncated: truncated,
        logBytes,
        logDigest,
      }
    }
    return {
      status: 'failed',
      exitCode: exitCode ?? undefined,
      // 只记录归一化原因：具体报错在日志里，不写进事件流
      statusReason: `进程以退出码 ${exitCode ?? 'unknown'} 结束，详见运行日志`,
      outputTruncated: truncated,
      logBytes,
      logDigest,
    }
  }
}

/** 计算本地文件摘要（产物完整性） */
export function sha256File(path: string): { digest: string; sizeBytes: number } {
  const buf = readFileSync(path)
  return { digest: createHash('sha256').update(buf).digest('hex'), sizeBytes: buf.byteLength }
}

/** 解析产物引用：相对路径（项目内）或外部引用（doi:/dvc:/http(s)） */
export function classifyArtifactRef(ref: string): 'local-file' | 'external' {
  if (/^(doi|dvc|s3|gs|https?):/i.test(ref)) return 'external'
  return 'local-file'
}
