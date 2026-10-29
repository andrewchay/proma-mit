/**
 * 桌面动作的结果判定。
 *
 * Computer Use 的动作（点击、输入、拖拽、滚动、快捷键）会改变用户机器状态，
 * 但服务只返回一句 message，抛错时也没有"是否已生效"的信息。直接抛错会让模型
 * 盲目重试，可能造成重复点击、重复提交或重复输入。
 *
 * 判定骨架与受管浏览器共用（见 `external-action-outcome.ts`），这里给出桌面域
 * 的判据与确认手段：
 * - `not_applied`：明确的前置失败（未授权、坐标非法、能力不可用），可以确认没有生效；
 * - `unknown`：超时、中断、未知异常，无法确认是否生效——按"结果未知"处理，
 *   要求先截图确认当前状态，禁止自动重试。
 *
 * 默认归为 `unknown`：拿不准时宁可让人确认，也不假设"没生效"。
 */

import {
  type ActionFailure,
  type ActionFailureRule,
  classifyActionFailure,
  describeActionFailure,
} from './external-action-outcome'

export type DesktopActionOutcome = 'applied' | 'not_applied' | 'unknown'
export type DesktopActionFailure = ActionFailure

const DESKTOP_RULE: ActionFailureRule = {
  preActionCodes: ['EPERM', 'EACCES', 'ENOTSUP', 'ENODEV', 'EINVAL', 'ENOENT'],
  unknownCodes: ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'EAGAIN'],
  preActionPattern: /未授权|无权限|没有权限|permission|denied|not permitted|不支持|不可用|unavailable|越界|out of range|invalid|无效/,
  unknownPattern: /超时|timeout|timed out|中断|aborted|abort|未知|unknown|信号|signal/,
}

const DESKTOP_CONFIRM_HINT = '请先调用 ComputerUseScreenshot 确认当前屏幕状态，再由用户决定是否继续。'

/** 归类桌面动作失败：只有能确认为前置失败时才算"未执行"。 */
export function classifyDesktopActionFailure(error: unknown): Omit<DesktopActionFailure, 'message'> {
  return classifyActionFailure(error, DESKTOP_RULE)
}

/** 生成工具结果文案：未知结果必须明确禁止自动重试并要求先确认屏幕状态。 */
export function describeDesktopActionFailure(action: string, error: unknown): DesktopActionFailure {
  return describeActionFailure(`ComputerUse${action}`, error, DESKTOP_RULE, DESKTOP_CONFIRM_HINT)
}
