import { expect, test } from 'bun:test'
import { observeGlmR01Usage } from './glm-r01-usage'

async function observe(parts: string[]): Promise<{ bytes: string; calls: number[][] }> {
  const calls: number[][] = []
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(encoder.encode(p)); c.close() } })
  const bytes = await new Response(stream.pipeThrough(observeGlmR01Usage((p, c) => calls.push([p, c])))).text()
  return { bytes, calls }
}

test('分块SSE透明传递，仅在DONE和完整usage后结算', async () => {
  const parts = ['data: {"usage":{"prompt_tokens":70', '00,"completion_tokens":50}}\n\ndata: [DO', 'NE]\n\n']
  const result = await observe(parts)
  expect(result.bytes).toBe(parts.join(''))
  expect(result.calls).toEqual([[7000, 50]])
})

test('缺usage、缺DONE或非法usage均不释放预留', async () => {
  expect((await observe(['data: [DONE]\n'])).calls).toEqual([])
  expect((await observe(['data: {"usage":{"prompt_tokens":7000,"completion_tokens":50}}\n'])).calls).toEqual([])
  expect((await observe(['data: {"usage":{"prompt_tokens":-1,"completion_tokens":50}}\ndata: [DONE]\n'])).calls).toEqual([])
})
