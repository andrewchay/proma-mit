import { expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { CreateBucketCommand, DeleteBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { S3AgentRuntimeObjectStore } from './app'

const endpoint = process.env.PROMA_S3_TEST_ENDPOINT
const browserTest = endpoint ? test : test.skip
browserTest('Given 本地 S3 兼容对象 When 流式读取 Then 大对象完整且可提前取消', async () => {
  const url = new URL(endpoint!)
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new Error('测试仅允许本机 S3 端点')
  const bucket = `gravitas-test-${randomUUID()}`, credentials = { accessKeyId: 'gravitas-test', secretAccessKey: 'gravitas-test-secret' }
  const client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials })
  const store = new S3AgentRuntimeObjectStore({ bucket, region: 'us-east-1', endpoint, ...credentials, maxUploadBytes: 1024 })
  await client.send(new CreateBucketCommand({ Bucket: bucket }))
  try {
    const body = new Uint8Array(2_000_000).map((_, index) => index % 251)
    await store.putObject({ key: 'large.bin', body, contentType: 'application/octet-stream' })
    const object = await store.getObjectStream('large.bin')
    expect(object?.contentType).toBe('application/octet-stream')
    const reader = object!.body.getReader(), hash = createHash('sha256')
    let size = 0
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; hash.update(value) }
    expect(size).toBe(body.byteLength)
    expect(hash.digest('hex')).toBe(createHash('sha256').update(body).digest('hex'))
    const partial = await store.getObjectStream('large.bin')
    const partialReader = partial!.body.getReader()
    expect((await partialReader.read()).value!.byteLength).toBeGreaterThan(0)
    await partialReader.cancel()
    expect(await store.getObjectStream('missing.bin')).toBeUndefined()
  } finally {
    await store.deleteObject('large.bin')
    await client.send(new DeleteBucketCommand({ Bucket: bucket }))
    client.destroy()
  }
}, 30000)
