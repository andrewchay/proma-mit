/** 前端展示旧 Runtime 时统一使用不暴露已下线名称的标签。 */
export function formatAgentRuntimeDisplayLabel(value: string): string {
  const normalized = value.toLowerCase()
  if (normalized.includes('claude') || normalized.includes('proma') || normalized.includes('gravitas')) {
    return '已下线 Runtime'
  }
  if (normalized === 'ai-sdk') return 'AI SDK'
  if (normalized === 'pi') return 'Pi'
  return value
}
