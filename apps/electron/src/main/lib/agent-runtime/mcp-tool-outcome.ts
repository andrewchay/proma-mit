/**
 * MCP 工具调用的结果判定。
 *
 * MCP 服务端是外部进程或远程服务，一次 `callTool` 抛错并不能说明工具没执行：
 * 请求可能已经送达并在服务端产生了副作用（发出邮件、写入远端记录、提交订单），
 * 只是响应在返回途中超时或连接断开。原先把所有失败压成一句「MCP 工具调用失败」，
 * 模型看到就会重试——在真实系统上是重复执行。
 *
 * 判定骨架与桌面、受管浏览器共用（见 `tool-impls/external-action-outcome.ts`），
 * 这里只额外采信 JSON-RPC 的 `-32601 Method not found`：它能明确证明方法不存在。
 * 参数与输出校验错误也可能在工具执行后由 SDK 抛出，不能据此推断没有副作用；
 * 其余错误码、系统错误码与错误文案一律不能解除派发后的未知状态。
 */

import {
  type ActionFailure,
  type ActionFailureRule,
  classifyActionFailure,
  describeActionError,
  describeActionFailure,
} from './tool-impls/external-action-outcome'

const MCP_RULE: ActionFailureRule = {
  preActionCodes: [],
  unknownCodes: ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'EAGAIN'],
  // 派发后的文案不能证明前置拒绝；只有下方的数字错误码 -32601 例外。
  preActionPattern: /$^/,
  unknownPattern: /超时|timeout|timed out|中断|aborted|abort|Connection closed|socket hang up|连接已关闭|连接中断|unknown|未知/,
}

const MCP_CONFIRM_HINT =
  '请先核对目标系统的实际状态（重新读取相关资源或查询对应系统），再由用户决定是否继续。'

/** 归类 MCP 工具调用失败：只有数字错误码 -32601 能确认方法未执行。 */
export function classifyMcpToolFailure(error: unknown): Omit<ActionFailure, 'message'> {
  const rpcCode = (error as { code?: unknown } | undefined)?.code
  if (rpcCode === -32601) return { outcome: 'not_applied', reason: describeActionError(error) }
  return classifyActionFailure(error, MCP_RULE)
}

/** 生成工具结果文案：未知结果必须明确禁止自动重试并要求先核对目标系统。 */
export function describeMcpToolFailure(toolName: string, error: unknown): ActionFailure {
  return describeActionFailure(`MCP 工具 ${toolName}`, error, MCP_RULE, MCP_CONFIRM_HINT, classifyMcpToolFailure)
}
