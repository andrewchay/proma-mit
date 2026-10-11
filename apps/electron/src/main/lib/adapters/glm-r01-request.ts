/** 试点本地gateway替换官方URL后，恢复Pi对bigmodel.cn自动检测的兼容行为。
 * 来源：Pi openai-completions detectCompat：system角色、max_tokens、zai thinking格式。
 * 只作用于试点，不扩大生产Provider能力声明。
 */
export function normalizeGlmR01Request(body: Record<string, unknown>, outputLimit: number): Record<string, unknown> {
  const result = { ...body }
  if (!Array.isArray(body.messages)) throw new Error('缺少messages')
  result.messages = body.messages.map((message: unknown) => {
    if (!message || typeof message !== 'object') throw new Error('无效message')
    const record = message as Record<string, unknown>
    return record.role === 'developer' ? { ...record, role: 'system' } : { ...record }
  })
  result.max_tokens = outputLimit
  delete result.max_completion_tokens
  delete result.store
  // 试点未请求thinkingLevel，恢复官方URL默认关闭thinking的行为。
  delete result.reasoning_effort
  result.thinking = { type: 'disabled' }
  return result
}
