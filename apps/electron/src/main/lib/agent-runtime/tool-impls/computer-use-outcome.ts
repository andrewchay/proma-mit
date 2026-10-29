/**
 * 桌面动作的结果判定。
 *
 * Computer Use 的动作（点击、输入、拖拽、滚动、快捷键）会改变用户机器状态，
 * 但服务只返回一句 message，抛错时也没有"是否已生效"的信息。直接抛错会让模型
 * 盲目重试，可能造成重复点击、重复提交或重复输入。
 *
 * 这里把失败分成两类：
 * - `not_applied`：明确的前置失败（未授权、坐标非法、能力不可用），可以确认没有生效；
 * - `unknown`：超时、中断、未知异常，无法确认是否生效——按"结果未知"处理，
 *   要求先截图确认当前状态，禁止自动重试。
 *
 * 默认归为 `unknown`：拿不准时宁可让人确认，也不假设"没生效"。
 */

export type DesktopActionOutcome = 'applied' | 'not_applied' | 'unknown'

export interface DesktopActionFailure {
  outcome: Exclude<DesktopActionOutcome, 'applied'>
  /** 归类的依据（原始错误信息，截断后保留）。 */
  reason: string
  /** 给模型的处理指令。 */
  message: string
}

/** 明确表示"动作没有被执行"的错误码。 */
const PRE_ACTION_CODES = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'ENODEV', 'EINVAL', 'ENOENT'])
/** 明确无法确认结果的错误码。 */
const UNKNOWN_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'EAGAIN'])
const PRE_ACTION_PATTERN = /未授权|无权限|没有权限|permission|denied|not permitted|不支持|不可用|unavailable|越界|out of range|invalid|无效/
const UNKNOWN_PATTERN = /超时|timeout|timed out|中断|aborted|abort|未知|unknown|信号|signal/

const describeError = (error: unknown): string => {
  if (error instanceof Error) return error.message.slice(0, 300)
  if (typeof error === 'string') return error.slice(0, 300)
  return String(error).slice(0, 300)
}

/** 归类桌面动作失败：只有能确认为前置失败时才算"未执行"。 */
export function classifyDesktopActionFailure(error: unknown): Omit<DesktopActionFailure, 'message'> {
  const reason = describeError(error)
  const name = error instanceof Error ? error.name : ''
  const code = (error as NodeJS.ErrnoException | undefined)?.code

  if (name === 'TimeoutError' || name === 'AbortError') return { outcome: 'unknown', reason }
  if (typeof code === 'string' && UNKNOWN_CODES.has(code)) return { outcome: 'unknown', reason }
  if (UNKNOWN_PATTERN.test(reason)) return { outcome: 'unknown', reason }
  if (typeof code === 'string' && PRE_ACTION_CODES.has(code)) return { outcome: 'not_applied', reason }
  if (PRE_ACTION_PATTERN.test(reason)) return { outcome: 'not_applied', reason }
  // 拿不准就不假设没生效。
  return { outcome: 'unknown', reason }
}

/** 生成工具结果文案：未知结果必须明确禁止自动重试并要求先确认屏幕状态。 */
export function describeDesktopActionFailure(action: string, error: unknown): DesktopActionFailure {
  const { outcome, reason } = classifyDesktopActionFailure(error)
  const prefix = `ComputerUse${action}`
  if (outcome === 'not_applied') {
    return { outcome, reason, message: `${prefix} 未执行（${reason}）：已确认动作没有生效，修正前置条件后可以重试。` }
  }
  return {
    outcome,
    reason,
    message: `${prefix} 结果未知（${reason}）：动作可能已经生效。禁止自动重试；请先调用 ComputerUseScreenshot 确认当前屏幕状态，再由用户决定是否继续。`,
  }
}
