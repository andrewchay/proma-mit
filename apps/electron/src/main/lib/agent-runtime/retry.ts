/**
 * Runtime 重试工具
 *
 * 为 Provider-Agnostic Agent Runtime 提供带指数退避的重试能力。
 */

/** 重试配置 */
export interface RetryOptions {
  /** 最大重试次数（不含首次尝试） */
  maxRetries: number
  /** 初始退避时间（毫秒） */
  baseDelayMs: number
  /** 判断错误是否可重试 */
  shouldRetry: (error: unknown) => boolean
  /** 每次重试前的回调 */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void
  /** 中止信号 */
  signal?: AbortSignal
}

/**
 * 执行异步操作并在可重试错误发生时进行重试
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxRetries, baseDelayMs, shouldRetry, onRetry, signal } = options

  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new Error('操作已中止')
    }

    try {
      return await fn()
    } catch (error) {
      lastError = error

      if (attempt === maxRetries) {
        break
      }

      if (!shouldRetry(error)) {
        throw error
      }

      const delayMs = baseDelayMs * 2 ** attempt
      onRetry?.(attempt + 1, error, delayMs)
      await sleep(delayMs, signal)
    }
  }

  throw lastError
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('操作已中止'))
      return
    }

    const timer = setTimeout(resolve, ms)

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('操作已中止'))
      },
      { once: true },
    )
  })
}
