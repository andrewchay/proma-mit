/** 透明传递SSE，只观察成功结束后的完整usage，不保存模型内容。 */
export function observeGlmR01Usage(onUsage: (prompt: number, completion: number) => void): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  let usage: { prompt: number; completion: number } | undefined
  const line = (text: string): void => {
    if (!text.startsWith('data:')) return
    const data = text.slice(5).trim()
    if (data === '[DONE]') { done = true; return }
    try {
      const event = JSON.parse(data) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
      const u = event.usage
      if (u && Number.isSafeInteger(u.prompt_tokens) && Number.isSafeInteger(u.completion_tokens)
        && u.prompt_tokens! > 0 && u.completion_tokens! >= 0) {
        usage = { prompt: u.prompt_tokens!, completion: u.completion_tokens! }
      }
    } catch { /* 非usage行不参与结算。 */ }
  }
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      buffer += decoder.decode(chunk, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, index).trimEnd())
        buffer = buffer.slice(index + 1)
      }
      if (buffer.length > 1_000_000) throw new Error('试点SSE单行过大')
    },
    flush() {
      buffer += decoder.decode()
      if (buffer) line(buffer.trimEnd())
      if (done && usage) onUsage(usage.prompt, usage.completion)
    },
  })
}
