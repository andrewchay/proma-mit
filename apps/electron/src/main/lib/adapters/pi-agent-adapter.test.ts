import { describe, expect, test } from 'bun:test'
import { PiAgentAdapter } from './pi-agent-adapter'

describe('PiAgentAdapter', () => {
  test('given required channel fields are missing then query fails with a helpful error', async () => {
    const adapter = new PiAgentAdapter()

    await expect(async () => {
      for await (const _message of adapter.query({ sessionId: 's-pi', prompt: 'hello', agentRuntime: 'pi' })) {
        // 配置不完整，不应产出消息。
      }
    }).toThrow('Pi Runtime 需要 provider、apiKey、baseUrl、model、cwd')
  })

  test('abort and dispose are safe when no Pi session is active', () => {
    const adapter = new PiAgentAdapter()

    expect(() => adapter.abort('s-pi')).not.toThrow()
    expect(() => adapter.dispose()).not.toThrow()
  })
})
