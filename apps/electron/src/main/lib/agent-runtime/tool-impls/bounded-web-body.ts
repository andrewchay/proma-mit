/** 限制实际接收字节；超限或中止时取消读取，不能相信 Content-Length。 */
export async function readBoundedWebBody(body: ReadableStream<Uint8Array> | null, signal: AbortSignal, maxBytes: number, label: string): Promise<Uint8Array> {
  if (signal.aborted) throw new Error('请求已取消或超时')
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (signal.aborted) throw new Error('请求已取消或超时')
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { cancel(); throw new Error(`${label}过大，已放弃读取`) }
      chunks.push(value)
    }
    const result = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
    return result
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

