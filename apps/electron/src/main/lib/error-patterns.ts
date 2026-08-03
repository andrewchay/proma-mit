/**
 * 瞬时网络错误模式
 *
 * 覆盖上游 API 偶发断流/抖动：API SSE 流中途 terminated、TCP 连接被重置、
 * DNS 抖动、fetch 层超时等。这些错误无 HTTP 状态码，SDK HTTP 客户端层
 * 内置的 2 次重试无法完全消化时，会穿透到 Orchestrator 应用层兜底。
 *
 * 同时覆盖 Pi SDK 的流式断流错误文本（openai-completions 的
 * "Stream ended without finish_reason"、anthropic-messages 的
 * "Anthropic stream ended before message_stop" / "stream ended before a
 * terminal response event"），否则 Pi 断流重试耗尽后抛出的错误无法被
 * orchestrator 识别为可重试，表现为 Pi runtime 断流而 AI SDK 正常。
 */
export const TRANSIENT_NETWORK_PATTERN =
  /terminated|socket hang up|ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|network error|connection (?:closed|lost|refused|reset)|AbortError|aborted|timed out|stream (?:closed|ended|disconnected) prematurely|premature close|other side closed|ended without|stream ended before|message_stop|finish_reason|terminal response event/i

/** 判断错误消息/stderr 是否为瞬时网络错误 */
export function isTransientNetworkError(message?: string, stderr?: string): boolean {
  if (!message && !stderr) return false
  return (
    (!!message && TRANSIENT_NETWORK_PATTERN.test(message)) ||
    (!!stderr && TRANSIENT_NETWORK_PATTERN.test(stderr))
  )
}
