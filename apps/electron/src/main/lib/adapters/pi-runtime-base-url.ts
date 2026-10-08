/** Pi渠道URL规范化；与模型注册、受控出口共用，避免重复规则。 */
import type { ProviderType } from '@gravitas/shared'
import { resolveAgentRuntimeBaseUrl } from '@gravitas/shared'

export function resolvePiBaseUrl(
	provider: ProviderType,
	baseUrl: string,
): string {
	const normalized = baseUrl.trim().replace(/\/+$/, '')
	if (provider === 'google') {
		return /\/v\d+(beta)?$/.test(normalized)
			? normalized
			: `${normalized}/v1beta`
	}
	if (provider === 'kimi-coding') {
		return normalized.replace(/\/v\d+\/messages$/, '').replace(/\/v\d+$/, '')
	}
	if (
		provider === 'openai' ||
		provider === 'deepseek-openai' ||
		provider === 'zhipu' ||
		provider === 'doubao' ||
		provider === 'qwen' ||
		provider === 'custom'
	) {
		return resolveAgentRuntimeBaseUrl(provider, 'proma', baseUrl)
	}
	return normalized
}
