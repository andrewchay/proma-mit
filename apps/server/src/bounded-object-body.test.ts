import { expect, test } from 'bun:test'
import { AgentRuntimeObjectTooLargeError, InMemoryAgentRuntimeObjectStore } from '@gravitas/shared/utils'
import { readBoundedObjectBody } from './bounded-object-body.ts'

test('Given 分块对象 When 超过读取限额 Then 取消流且不继续读取', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])) },
    cancel() { cancelled = true },
  })
  await expect(readBoundedObjectBody(stream, 3)).rejects.toBeInstanceOf(AgentRuntimeObjectTooLargeError)
  expect(cancelled).toBe(true)
})

test('Given 读取上限 When 字节数恰好等于上限 Then 返回完整数据，内存实现同样拒绝超限', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.enqueue(new Uint8Array([2, 3])); controller.close() } })
  expect([...(await readBoundedObjectBody(stream, 3))]).toEqual([1, 2, 3])
  const objects = new InMemoryAgentRuntimeObjectStore()
  await objects.putObject({ key: 'x', body: new Uint8Array([1, 2, 3]) })
  await expect(objects.getObject('x', { maxBytes: 2 })).rejects.toBeInstanceOf(AgentRuntimeObjectTooLargeError)
  expect((await objects.getObject('x', { maxBytes: 3 }))?.body.byteLength).toBe(3)
})

test('Given S3 兼容 HTTP 对象 When 请求限额读取 Then 使用真实客户端验证边界', async () => {
  const { S3AgentRuntimeObjectStore } = await import('./app.ts')
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(new Uint8Array([1, 2, 3, 4, 5])) })
  try {
    const store = new S3AgentRuntimeObjectStore({ bucket: 'fixture', region: 'auto', endpoint: `http://127.0.0.1:${server.port}`, accessKeyId: 'test', secretAccessKey: 'test', maxUploadBytes: 16 })
    await expect(store.getObject('item', { maxBytes: 4 })).rejects.toBeInstanceOf(AgentRuntimeObjectTooLargeError)
    expect([...(await store.getObject('item', { maxBytes: 5 }))!.body]).toEqual([1, 2, 3, 4, 5])
  } finally { server.stop(true) }
})


test('Given S3 响应尚未结束 When 读取对象流 Then 不等待完整对象即可获得首块', async () => {
  const { S3AgentRuntimeObjectStore } = await import('./app.ts')
  const upstream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])) } })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(upstream, { headers: { 'content-type': 'text/plain' } }) })
  try {
    const store = new S3AgentRuntimeObjectStore({ bucket: 'fixture', region: 'auto', endpoint: `http://127.0.0.1:${server.port}`, accessKeyId: 'test', secretAccessKey: 'test', maxUploadBytes: 16 })
    const result = await store.getObjectStream('item')
    expect(result?.contentType).toBe('text/plain')
    const reader = result!.body.getReader()
    expect([...(await reader.read()).value!]).toEqual([1, 2, 3])
    await reader.cancel()
  } finally { server.stop(true) }
})
