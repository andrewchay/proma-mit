/**
 * 受管浏览器动作的结果判定。
 *
 * Web Bridge 的动作走 CDP 真实输入：点击可能已经提交表单、输入可能已经写入、
 * 下载可能已经落盘。一旦调用中途抛错（连接断开、协议错误、超时），工具层原本只是
 * 把异常抛给模型，模型最常见的反应就是重试——在真实网站上这是重复提交订单、重复下单。
 *
 * 判据与桌面域分开：桌面的错误码来自 macOS 桌面服务，这里的错误码与文案来自
 * CDP/WebSocket 与浏览器引擎，"Target closed" 这类断连恰好发生在动作发出之后，
 * 必须归为结果未知，而非未执行。
 */

import {
  type ActionFailure,
  type ActionFailureRule,
  classifyActionFailure,
  describeActionFailure,
} from './external-action-outcome'

const WEB_BRIDGE_RULE: ActionFailureRule = {
  // 连接前的明确拒绝：没连上就不可能发出动作。
  preActionCodes: ['EPERM', 'EACCES', 'ENOENT', 'EINVAL', 'ENOTSUP', 'ENOTFOUND'],
  unknownCodes: ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'EAGAIN'],
  // 前置条件不成立或目标不存在：动作没有派发出去。
  // 裸 invalid/无效 太宽——CDP 也会在事件已经派发后才报 invalid，因此收窄到参数上下文。
  preActionPattern:
    /未导航|尚未导航|未连接|没有连接|未开启|没有开启|必须先|失效|过期|stale|不存在|找不到|not found|No node with given id|No target with given id|element_id|Invalid parameter|Invalid argument|参数无效|未授权|denied|not authorized|unsupported|不支持/,
  // 连接与协议层面的失败：动作可能已经发出。
  unknownPattern:
    /Target closed|Session closed|session closed|WebSocket|socket hang up|socket closed|Protocol error|detached|disconnected|连接已关闭|连接中断|通道关闭|超时|timeout|timed out|中断|aborted|abort|interrupted|未知|unknown/,
}

const DEFAULT_CONFIRM_HINT =
  '请先调用 WebBridgeObserve 或 WebBridgeSnapshot 确认页面状态（必要时 WebBridgeScreenshot），再由用户决定是否继续。'

/** 下载类动作的确认手段是检查落盘结果，而不是页面状态。 */
export const DOWNLOAD_CONFIRM_HINT =
  '请先确认下载目录是否已产生文件（必要时用 WebBridgeListTabs 与 WebBridgeSnapshot 核对页面提示），再由用户决定是否继续。'

/** 归类受管浏览器动作失败：只有能确认的前置失败才算"未执行"。 */
export function classifyWebBridgeActionFailure(error: unknown): Omit<ActionFailure, 'message'> {
  return classifyActionFailure(error, WEB_BRIDGE_RULE)
}

/** 生成工具结果文案：未知结果必须明确禁止自动重试并要求先确认页面状态。 */
export function describeWebBridgeActionFailure(action: string, error: unknown, hint = DEFAULT_CONFIRM_HINT): ActionFailure {
  return describeActionFailure(`WebBridge${action}`, error, WEB_BRIDGE_RULE, hint)
}
