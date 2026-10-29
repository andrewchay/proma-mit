import { AgentRuntimeObjectTooLargeError } from '@gravitas/shared/utils'

/** 逐块读取并限制累计字节；超限时取消流，不信任远端声明的长度。 */
export async function readBoundedObjectBody(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('读取大小限制无效')
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new AgentRuntimeObjectTooLargeError()
      }
      chunks.push(value)
    }
    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
    return result
  } finally { reader.releaseLock() }
}
