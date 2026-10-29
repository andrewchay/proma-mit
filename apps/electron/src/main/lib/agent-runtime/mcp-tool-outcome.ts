/**
 * MCP 工具调用的结果判定。
 *
 * MCP 服务端是外部进程或远程服务，一次 `callTool` 抛错并不能说明工具没执行：
 * 请求可能已经送达并在服务端产生了副作用（发出邮件、写入远端记录、提交订单），
 * 只是响应在返回途中超时或连接断开。原先把所有失败压成一句「MCP 工具调用失败」，
 * 模型看到就会重试——在真实系统上是重复执行。
 *
 * 判定骨架与桌面、受管浏览器共用（见 `tool-impls/external-action-outcome.ts`），
 * 这里额外利用 JSON-RPC 错误码：服务端明确拒绝请求（方法不存在、参数非法）可以
 * 判为未执行；其余错误码与传输层失败一律按结果未知处理。
 */

import {
  type ActionFailure,
  type ActionFailureRule,
  classifyActionFailure,
  describeActionError,
  describeActionFailure,
} from './tool-impls/external-action-outcome'

/** 服务端明确拒绝请求，工具没有执行。 */
const NOT_APPLIED_RPC_CODES = new Set([
  -32600, // Invalid Request
  -32601, // Method not found
  -32602, // Invalid params
])

const MCP_RULE: ActionFailureRule = {
  preActionCodes: ['EPERM', 'EACCES', 'ENOENT', 'ENOTSUP'],
  unknownCodes: ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'EAGAIN'],
  preActionPattern: /未连接|not connected|Method not found|Invalid params|Invalid Request|工具不存在|未知工具|找不到工具|权限|denied|不支持的/,
  unknownPattern: /超时|timeout|timed out|中断|aborted|abort|Connection closed|socket hang up|连接已关闭|连接中断|unknown|未知/,
}

const MCP_CONFIRM_HINT =
  '请先核对目标系统的实际状态（重新读取相关资源或查询对应系统），再由用户决定是否继续。'

/** 归类 MCP 工具调用失败：只有服务端明确拒绝时才算"未执行"。 */
export function classifyMcpToolFailure(error: unknown): Omit<ActionFailure, 'message'> {
  const rpcCode = (error as { code?: unknown } | undefined)?.code
  if (typeof rpcCode === 'number') {
    const reason = describeActionError(error)
    return { outcome: NOT_APPLIED_RPC_CODES.has(rpcCode) ? 'not_applied' : 'unknown', reason }
  }
  return classifyActionFailure(error, MCP_RULE)
}

/** 生成工具结果文案：未知结果必须明确禁止自动重试并要求先核对目标系统。 */
export function describeMcpToolFailure(toolName: string, error: unknown): ActionFailure {
  return describeActionFailure(`MCP 工具 ${toolName}`, error, MCP_RULE, MCP_CONFIRM_HINT, classifyMcpToolFailure)
}
