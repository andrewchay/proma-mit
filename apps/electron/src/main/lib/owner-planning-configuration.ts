import { decryptApiKey, getChannelById } from './channel-manager'

const CONFIGURATION_ERROR = 'Owner发送前配置检查失败'
const LEGACY_MISSING_OPTIONS = 'AI SDK Runtime 需要 provider、apiKey、baseUrl、model、cwd'

/** 在发行预算和进入Runtime前校验解密后的凭据；不记录密钥，也不发送请求。 */
export function readOwnerPlanningApiKey(channelId: string): string {
  const channel = getChannelById(channelId)
  if (!channel || channel.enabled === false) throw new Error('Owner模型服务不可用')
  let apiKey: string
  try { apiKey = decryptApiKey(channelId) }
  catch { throw new Error(`${CONFIGURATION_ERROR}（credential_unavailable）：服务凭据无法解密，请在设置 → AI 服务中重新保存 API Key。本次请求未发送。`) }
  if (!apiKey.trim()) throw new Error(`${CONFIGURATION_ERROR}（missing_api_key）：服务“${channel.name ?? channelId}”缺少 API Key，请在设置 → AI 服务中填写并保存。本次请求未发送。`)
  return apiKey
}

/** 只识别已知的本地入口错误；是否未发送还必须核对持久准入与全部回执。 */
export function isOwnerPlanningConfigurationError(message: string | null | undefined): boolean {
  return message === LEGACY_MISSING_OPTIONS
    || Boolean(message?.startsWith(`${CONFIGURATION_ERROR}（missing_api_key）：`)
      || message?.startsWith(`${CONFIGURATION_ERROR}（credential_unavailable）：`))
}
