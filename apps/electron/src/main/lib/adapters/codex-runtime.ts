import type { CredentialStore, OAuthCredential } from '@earendil-works/pi-ai'
import { parseCodexCredentials, serializeCodexCredentials } from '@gravitas/shared'
import { decryptApiKey, getChannelById, updateChannel } from '../channel-manager'
import { loadPiCodingAgent } from './pi-sdk-loader'

const credentialLocks = new Map<string, Promise<void>>()

async function withChannelLock<T>(channelId: string, task: () => Promise<T>): Promise<T> {
  const previous = credentialLocks.get(channelId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  credentialLocks.set(channelId, current)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (credentialLocks.get(channelId) === current) credentialLocks.delete(channelId)
  }
}

/** 用应用加密渠道作为唯一凭据源，不读写 Pi 的全局 auth.json。 */
export function createCodexCredentialStore(channelId: string): CredentialStore {
  const readCurrent = (): OAuthCredential | undefined => {
    const channel = getChannelById(channelId)
    if (!channel || channel.provider !== 'openai-codex') return undefined
    const parsed = parseCodexCredentials(decryptApiKey(channelId))
    return parsed ? { type: 'oauth', ...parsed } : undefined
  }
  return {
    async read(providerId) {
      return providerId === 'openai-codex' ? readCurrent() : undefined
    },
    async list() {
      return readCurrent() ? [{ providerId: 'openai-codex', type: 'oauth' as const }] : []
    },
    async modify(providerId, fn) {
      if (providerId !== 'openai-codex') return undefined
      return withChannelLock(channelId, async () => {
        const current = readCurrent()
        const updated = await fn(current)
        if (!updated) return current
        if (updated.type !== 'oauth') throw new Error('Codex 渠道只允许 OAuth 凭据')
        const latest = readCurrent()
        if (!latest || JSON.stringify(latest) !== JSON.stringify(current)) {
          // 登录/重新授权可能同时替换凭据；不得将旧 refresh 结果覆盖新账号。
          throw new Error('ChatGPT 登录状态已改变，请重试')
        }
        updateChannel(channelId, { apiKey: serializeCodexCredentials(updated) })
        return updated
      })
    },
    async delete() {
      throw new Error('请在渠道设置中管理 ChatGPT 登录状态')
    },
  }
}

export async function createCodexRuntime(channelId: string) {
  const { ModelRuntime } = await loadPiCodingAgent()
  return ModelRuntime.create({
    credentials: createCodexCredentialStore(channelId),
    modelsPath: null,
    allowModelNetwork: false,
  })
}
