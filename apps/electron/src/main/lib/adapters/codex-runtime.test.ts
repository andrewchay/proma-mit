import { describe, expect, test, mock } from 'bun:test'

let secret = JSON.stringify({ access: 'old', refresh: 'refresh-old', expires: 1000 })
let writes = 0
mock.module('../channel-manager', () => ({
  getChannelById: () => ({ provider: 'openai-codex' }),
  decryptApiKey: () => secret,
  updateChannel: (_id: string, update: { apiKey: string }) => { secret = update.apiKey; writes++ },
}))
const { createCodexCredentialStore } = await import('./codex-runtime')

describe('Codex channel credential store', () => {
  test('读 OAuth、不暴露给其他 provider；并发刷新串行读取最新状态', async () => {
    const store = createCodexCredentialStore('channel')
    expect(await store.read('other')).toBeUndefined()
    expect(await store.read('openai-codex')).toMatchObject({ type: 'oauth', access: 'old' })
    const [first, second] = await Promise.all([
      store.modify('openai-codex', async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { type: 'oauth', access: 'first', refresh: 'refresh-first', expires: 2000 }
      }),
      store.modify('openai-codex', async (current) => {
        expect(current).toMatchObject({ access: 'first' })
        return undefined
      }),
    ])
    expect(first).toMatchObject({ access: 'first' })
    expect(second).toMatchObject({ access: 'first' })
    expect(writes).toBe(1)
  })

  test('刷新期间用户重新登录时不覆盖新账号', async () => {
    const store = createCodexCredentialStore('channel')
    await expect(store.modify('openai-codex', async () => {
      secret = JSON.stringify({ access: 'new-login', refresh: 'new-refresh', expires: 3000 })
      return { type: 'oauth', access: 'stale', refresh: 'stale-refresh', expires: 2000 }
    })).rejects.toThrow('登录状态已改变')
    expect(await store.read('openai-codex')).toMatchObject({ access: 'new-login' })
    expect(writes).toBe(1)
  })
})
