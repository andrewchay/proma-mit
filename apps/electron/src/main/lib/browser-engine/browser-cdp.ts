/**
 * Browser Engine CDP 命令封装（供 Gravitas 自主实现）
 *
 * 目标：统一封装 Electron webContents.debugger (CDP) 的命令调用，处理
 * sendCommand 可能永不 settle 的问题：
 *  - 每次命令带超时（Promise.race 包装），超时后尝试重连 debugger；
 *  - 支持 AbortSignal 中止（中止后不再执行后续页面动作，但已发出的无法撤销）；
 *  - 定义浏览器命令超时、Observe 超时等常量。
 */

export const BROWSER_CDP_COMMAND_TIMEOUT_MS = 8_000
export const BROWSER_OBSERVE_TIMEOUT_MS = 5_000

export class BrowserCdpTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`页面未在 ${Math.ceil(timeoutMs / 1_000)} 秒内响应 ${method}，请稍后重试或重新加载页面。`)
    this.name = 'BrowserCdpTimeoutError'
  }
}

export class BrowserOperationAbortedError extends Error {
  constructor() {
    super('浏览器操作已停止。已发送的页面指令可能已执行，页面状态请重新观察确认。')
    this.name = 'BrowserOperationAbortedError'
  }
}

/** 已中止则直接抛错。 */
export function throwIfBrowserOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BrowserOperationAbortedError()
}

export type CdpCommandFn = () => Promise<unknown>

/**
 * 让 CDP 命令受超时与中止约束。
 * 底层 command 后续 settle 时会被安全忽略，不会泄漏异常。
 */
export function withBrowserCdpTimeout<T>(
  command: CdpCommandFn,
  method: string,
  timeoutMs = BROWSER_CDP_COMMAND_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (cb: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      cb()
    }
    const onAbort = () => settle(() => reject(new BrowserOperationAbortedError()))
    timer = setTimeout(() => settle(() => reject(new BrowserCdpTimeoutError(method, timeoutMs))), timeoutMs)
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })

    void Promise.resolve()
      .then(() => command())
      .then((value) => settle(() => resolve(value as T)))
      .catch((error: unknown) => settle(() => reject(error)))
  })
}
