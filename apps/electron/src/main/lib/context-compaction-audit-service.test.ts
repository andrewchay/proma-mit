import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const configDir = await mkdtemp(join(tmpdir(), 'proma-context-compaction-audit-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir

const { appendContextCompactionAudit, getContextCompactionMetrics } = await import('./context-compaction-audit-service')

afterAll(async () => {
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  await rm(configDir, { recursive: true, force: true })
})

describe('上下文压缩审计', () => {
  test('聚合本机记录，不读取或返回压缩正文', async () => {
    appendContextCompactionAudit({
      sessionId: 'session-1',
      runtime: 'proma',
      trigger: 'overflow_recovery',
      packetVersion: 1,
      estimatedTokensAfter: 4096,
    })

    expect(await getContextCompactionMetrics()).toEqual({
      total: 1,
      byRuntime: [{ key: 'proma', count: 1 }],
      byTrigger: [{ key: 'overflow_recovery', count: 1 }],
      latestAt: expect.any(String),
    })
  })
})
