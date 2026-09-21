/** 模型流首响应与流中空闲超时的共享策略。 */

/** 已开始输出后的最大静默时间。 */
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 120_000

/** 慢模型大上下文 prefill 的保守吞吐假设。 */
const PREFILL_TOKENS_PER_SECOND = 500

/** 首响应最长宽限，与上下文压缩超时上限一致。 */
export const MODEL_FIRST_RESPONSE_MAX_TIMEOUT_MS = 480_000

/**
 * 按估算上下文大小计算首响应宽限；首响应后应恢复 MODEL_STREAM_IDLE_TIMEOUT_MS。
 */
export function resolveModelFirstResponseTimeoutMs(estimatedContextTokens: number): number {
  const adaptive = Math.ceil(Math.max(0, estimatedContextTokens) / PREFILL_TOKENS_PER_SECOND) * 1_000
  return Math.min(
    Math.max(MODEL_STREAM_IDLE_TIMEOUT_MS, adaptive),
    MODEL_FIRST_RESPONSE_MAX_TIMEOUT_MS,
  )
}

export function resolveModelStreamIdleTimeoutMs(hasModelActivity: boolean, firstResponseTimeoutMs: number): number {
  return hasModelActivity ? MODEL_STREAM_IDLE_TIMEOUT_MS : firstResponseTimeoutMs
}

export function createModelStreamIdleTimeoutError(runtime: string, timeoutMs: number): Error {
  const error = new Error(
    `${runtime} 模型流空闲超时 (no model activity for ${timeoutMs}ms): stream ended without data`,
  )
  error.name = 'AbortError'
  return error
}

/** 为一次 AsyncIterator.next() 添加可中断的空闲看门狗。 */
export async function nextWithIdleTimeout<T>(input: {
  iterator: AsyncIterator<T>
  timeoutMs: number
  runtime: string
  onTimeout: () => void
}): Promise<IteratorResult<T>> {
  if (input.timeoutMs <= 0) return input.iterator.next()

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      input.iterator.next(),
      new Promise<IteratorResult<T>>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = createModelStreamIdleTimeoutError(input.runtime, input.timeoutMs)
          input.onTimeout()
          reject(error)
        }, input.timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
