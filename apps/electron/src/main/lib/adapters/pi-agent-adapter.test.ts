import { describe, expect, test } from 'bun:test'
import { PiAgentAdapter } from './pi-agent-adapter'

describe('PiAgentAdapter', () => {
  test('given Pi runtime is selected before SDK integration then query fails with an explicit unavailable error', async () => {
    const adapter = new PiAgentAdapter()

    await expect(async () => {
      for await (const _message of adapter.query({ sessionId: 's-pi', prompt: 'hello', agentRuntime: 'pi' })) {
        // Pi runtime 当前不可用，不应产出消息。
      }
    }).toThrow('Pi Agent runtime 尚未接入')
  })

  test('abort and dispose are safe no-ops before long-lived Pi resources exist', () => {
    const adapter = new PiAgentAdapter()

    expect(() => adapter.abort('s-pi')).not.toThrow()
    expect(() => adapter.dispose()).not.toThrow()
  })
})
