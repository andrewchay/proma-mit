/**
 * Owner 运行验证：受管浏览器断言执行器。
 *
 * 职责：只读打开工作区内的 HTML 成果，在受管浏览器上下文执行系统内置断言，产出逐项结果。
 * 边界：
 * - 文件必须落在给定工作区根内，拒绝符号链接、非 HTML、越界路径；
 * - 使用独立 partition 并阻断一切非 file 请求，页面无法访问网络；
 * - 断言脚本来自内置模板，本模块不接受调用方传入脚本；
 * - 本模块只产出证据，不判断业务质量，也不写入工作区文件。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { OWNER_RUNTIME_ASSERTION_TEMPLATES, type OwnerRuntimeAssertionTemplate, selectOwnerRuntimeAssertionTemplates } from './owner-runtime-assertion-templates'

export interface OwnerRuntimeBrowserCheckResult {
  id: string
  title: string
  status: 'passed' | 'failed' | 'skipped'
  detail: string
}

export interface OwnerRuntimeBrowserRunResult {
  checks: OwnerRuntimeBrowserCheckResult[]
  durationMs: number
  timedOut: boolean
  /** 实际验证的文件（相对工作区） */
  relativePath: string
}

export interface OwnerRuntimeBrowserRunInput {
  filePath: string
  templates: readonly OwnerRuntimeAssertionTemplate[]
  timeoutMs: number
}

export type OwnerRuntimeBrowserRunner = (input: OwnerRuntimeBrowserRunInput) => Promise<OwnerRuntimeBrowserRunResult>

export class OwnerRuntimeVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OwnerRuntimeVerificationError'
  }
}

const DEFAULT_TIMEOUT_MS = 60_000
/**
 * 每次验证使用独立的内存 partition（无 `persist:` 前缀即不落盘）。
 * 共用同一 partition 时，并行验证会互相清空/覆盖 localStorage，
 * 让"持久化"证据串到别的项目上。
 */
function createVerificationPartition(): string {
  return `owner-runtime-verification-${randomUUID()}`
}

let injectedRunner: OwnerRuntimeBrowserRunner | null = null

/** 测试与后续发行片注入执行器；传 null 恢复默认受管浏览器实现。 */
export function setOwnerRuntimeBrowserRunner(runner: OwnerRuntimeBrowserRunner | null): void {
  injectedRunner = runner
}

/**
 * 解析并校验待验证文件：必须位于工作区根内、非符号链接、扩展名为 HTML。
 * 校验失败直接抛错，不做"降级为跳过"，避免把环境问题伪装成通过。
 */
export function resolveOwnerRuntimeVerificationTarget(workspaceRoot: string, relativePath: string): string {
  if (!workspaceRoot?.trim()) throw new OwnerRuntimeVerificationError('缺少工作区根目录')
  const trimmed = relativePath?.trim()
  if (!trimmed) throw new OwnerRuntimeVerificationError('缺少待验证文件路径')
  if (isAbsolute(trimmed)) throw new OwnerRuntimeVerificationError('只接受工作区内相对路径')
  const root = resolve(workspaceRoot)
  const target = resolve(root, trimmed)
  const inside = relative(root, target)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new OwnerRuntimeVerificationError('待验证文件不在工作区内')
  if (!existsSync(target)) throw new OwnerRuntimeVerificationError(`待验证文件不存在：${relativePath}`)
  if (lstatSync(target).isSymbolicLink()) throw new OwnerRuntimeVerificationError('拒绝对符号链接验证')
  if (!['.html', '.htm'].includes(extname(target).toLowerCase())) throw new OwnerRuntimeVerificationError('目前只支持验证 HTML 成果')
  // 再次用真实路径确认没有借父目录软链逃出工作区。
  const realTarget = realpathSync(target)
  const realInside = relative(realpathSync(root), realTarget)
  if (!realInside || realInside.startsWith('..') || isAbsolute(realInside)) throw new OwnerRuntimeVerificationError('待验证文件真实路径不在工作区内')
  return realTarget
}

/**
 * 执行一次浏览器断言验证。
 *
 * @param input.workspaceRoot 工作区根（成果必须在其内）
 * @param input.relativePath 相对工作区的 HTML 路径
 * @param input.intents Owner 声明的检查意图，用于选择内置断言
 */
export async function runOwnerRuntimeBrowserAssertions(input: {
  workspaceRoot: string
  relativePath: string
  intents: readonly string[]
  /** 显式指定断言模板（来自 browser: 验证命令）；缺省才按意图选择。 */
  templates?: readonly OwnerRuntimeAssertionTemplate[]
  timeoutMs?: number
}): Promise<OwnerRuntimeBrowserRunResult> {
  const filePath = resolveOwnerRuntimeVerificationTarget(input.workspaceRoot, input.relativePath)
  const templates = input.templates ? [...input.templates] : selectOwnerRuntimeAssertionTemplates(input.intents)
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const runner = injectedRunner ?? defaultBrowserRunner
  const result = await runner({ filePath, templates, timeoutMs })
  return { ...result, relativePath: input.relativePath }
}

/** 内置断言总数，供诊断与边界展示使用。 */
export function ownerRuntimeAssertionCount(): number {
  return OWNER_RUNTIME_ASSERTION_TEMPLATES.length
}

/**
 * 默认执行器：隐藏窗口 + 独立 partition + 阻断非 file 请求。
 * 单独抽出以便测试注入假实现，真实执行路径需要 Electron 运行时。
 */
const defaultBrowserRunner: OwnerRuntimeBrowserRunner = async ({ filePath, templates, timeoutMs }) => {
  const { BrowserWindow, session } = await import('electron')
  const partition = createVerificationPartition()
  const partitionSession = session.fromPartition(partition)
  // 只允许本次成果自身、data: 与 about:。放宽到任意 file: 会让页面跳到本机其他文件，
  // 而断言会把页面文本写进证据详情，等于把本地文件内容带进证据链。
  const allowedTarget = pathToFileURL(filePath).href
  partitionSession.webRequest.onBeforeRequest((details, callback) => {
    const beyondTarget = details.url !== allowedTarget && !details.url.startsWith(`${allowedTarget}#`) && !details.url.startsWith(`${allowedTarget}?`)
    callback({ cancel: beyondTarget && !/^(data|about):/i.test(details.url) })
  })
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  })
  const startedAt = Date.now()
  const pageErrors: string[] = []
  const onConsole = (_event: unknown, level: number, message: string) => {
    if (level >= 3) pageErrors.push(message.slice(0, 200))
  }
  window.webContents.on('console-message', onConsole as never)
  window.webContents.on('did-fail-load', (_event, code, description) => { pageErrors.push(`${code} ${description}`.slice(0, 200)) })
  // 成果不能把窗口导航到别处：离开本次目标即取消，防止借导航读取其他本地文件。
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== allowedTarget && !url.startsWith(`${allowedTarget}#`) && !url.startsWith(`${allowedTarget}?`)) {
      event.preventDefault()
      pageErrors.push('页面尝试导航到其他地址，已阻止')
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const checks: OwnerRuntimeBrowserCheckResult[] = []
  let timedOut = false
  const deadline = startedAt + timeoutMs
  /** 受控等待：超过剩余预算即放弃并终止页面加载，避免异常页面让验证长期不返回。 */
  const withinDeadline = async <T>(work: () => Promise<T>, label: string): Promise<T> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`${label} 超时`)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            // 停止加载，让挂起的 loadFile/求值尽快结束；随后由外层按超时处理。
            if (!window.isDestroyed()) window.webContents.stop()
            reject(new Error(`${label} 超时`))
          }, remaining)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  try {
    // 独立 partition 已隔离历史数据；仍清一次，防止同名会话被复用时残留。
    await withinDeadline(() => partitionSession.clearStorageData({
      storages: ['localstorage', 'indexdb', 'websql', 'cookies', 'serviceworkers', 'cachestorage'],
    }), '清理历史存储')
    await withinDeadline(() => window.loadFile(filePath), '页面加载')
    // 注入错误收集器，供 html.loads 断言读取；注入失败不致命。
    await withinDeadline(
      () => window.webContents.executeJavaScript(`window.__ownerAssertionErrors = ${JSON.stringify(pageErrors)}; true`),
      '错误收集器注入',
    ).catch(() => undefined)
    for (const template of templates) {
      if (Date.now() >= deadline) { timedOut = true; break }
      // 成果可能在加载期把窗口导航到别的本地文件：一旦离开目标地址，
      // 后面的断言会读到另一份文档，必须立即失败并停止，不能产出任何证据。
      const currentUrl = window.webContents.getURL()
      if (currentUrl !== allowedTarget) {
        pageErrors.push(`页面已离开目标地址：${currentUrl.slice(0, 200)}`)
        checks.push({ id: template.id, title: template.title, status: 'failed', detail: '页面已导航到其他地址，拒绝读取该文档' })
        break
      }
      try {
        let raw = await withinDeadline(
          () => window.webContents.executeJavaScript(template.script, true),
          `断言 ${template.id}`,
        ) as { passed?: boolean; skipped?: boolean; detail?: string; bestScore?: string } | null
        if (template.id === 'storage.best-score' && raw?.passed === true) {
          const before = raw.bestScore
          await withinDeadline(() => window.loadFile(filePath), '最高分刷新检查')
          if (window.webContents.getURL() !== allowedTarget) throw new Error('刷新后已离开目标页面')
          const after = await withinDeadline(() => window.webContents.executeJavaScript(template.script, true), '刷新后最高分检查') as typeof raw
          raw = after?.passed === true && before && after.bestScore === before
            ? { ...after, detail: `${after.detail}；刷新后保持一致` }
            : { passed: false, detail: '刷新后最高分未恢复，或持久值发生变化' }
        }
        const status = raw?.passed === true ? 'passed' : raw?.skipped === true ? 'skipped' : 'failed'
        checks.push({ id: template.id, title: template.title, status, detail: String(raw?.detail ?? '').slice(0, 500) })
      } catch (error) {
        const message = (error as Error).message
        const isTimeout = message.includes('超时') || message.includes('timeout')
        if (isTimeout) timedOut = true
        checks.push({ id: template.id, title: template.title, status: 'failed', detail: `断言执行失败：${message}`.slice(0, 500) })
        if (timedOut) break
      }
    }
  } catch (error) {
    // 加载失败或被导航中止：此时没有断言结果，必须为每条断言留下失败记录，
    // 而不是返回"空证据"让调用方自行解读。
    const message = (error as Error).message
    if (message.includes('超时') || message.includes('timeout')) timedOut = true
    pageErrors.push(message.slice(0, 200))
    for (const template of templates) {
      if (checks.some(check => check.id === template.id)) continue
      checks.push({ id: template.id, title: template.title, status: 'failed', detail: `页面未能完成加载：${message}`.slice(0, 500) })
    }
  } finally {
    window.webContents.off('console-message', onConsole as never)
    if (!window.isDestroyed()) window.destroy()
  }
  return { checks, durationMs: Date.now() - startedAt, timedOut, relativePath: filePath }
}
