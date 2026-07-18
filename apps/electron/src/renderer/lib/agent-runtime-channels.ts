import type { AgentRuntime, Channel } from '@proma/shared'
import { isAgentCompatibleProvider } from '@proma/shared'

export function getAgentRuntimeChannelIds(
  channels: Channel[],
  claudeRuntimeChannelIds: string[],
  runtime: AgentRuntime = 'claude',
): string[] {
  return channels
    .filter((channel) => {
      if (!channel.enabled || !channel.models.some((model) => model.enabled)) return false
      if (!isAgentCompatibleProvider(channel.provider, runtime)) return false
      if (runtime === 'claude') return claudeRuntimeChannelIds.includes(channel.id)
      return true
    })
    .map((channel) => channel.id)
}

export function isAgentRuntimeChannelUsable(
  channels: Channel[],
  channelId: string | null | undefined,
  claudeRuntimeChannelIds: string[],
  runtime: AgentRuntime = 'claude',
): boolean {
  if (!channelId) return false
  return getAgentRuntimeChannelIds(channels, claudeRuntimeChannelIds, runtime).includes(channelId)
}
