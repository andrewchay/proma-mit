/**
 * 外部动作的结果判定基建。
 *
 * 桌面控制与受管浏览器是两类"发出去就收不回"的动作：点击、输入、提交、下载都可能
 * 已经生效，但调用方只拿到一句 message 或一个异常。直接把它当失败就会让模型盲目
 * 重试——重复点击、重复提交、重复下载，在用户机器或真实网站上叠加本不该发生的操作。
 *
 * 这里只提供两类判定共用的骨架，判据由各域自己给：
 * - `not_applied`：明确的前置失败，能确认动作没有发生；
 * - `unknown`：超时、中断、连接中途消失、未知异常，无法确认是否已经发生。
 *
 * 默认 `unknown`：拿不准时宁可让人先确认，也不假设"没生效"。
 */

export type ActionOutcome = 'applied' | 'not_applied' | 'unknown'

/** 未生效时的可确认失败结果。 */
export type ActionFailureOutcome = Exclude<ActionOutcome, 'applied'>

export interface ActionFailure {
  outcome: ActionFailureOutcome
  /** 归类的依据（原始错误信息，截断后保留）。 */
  reason: string
  /** 给模型的处理指令。 */
  message: string
}

export interface ActionFailureRule {
  /** 明确表示"动作没有被执行"的错误码。 */
  preActionCodes: readonly string[]
  /** 明确无法确认结果的错误码。 */
  unknownCodes: readonly string[]
  /** 明确表示"动作没有被执行"的错误文案。 */
  preActionPattern: RegExp
  /** 明确表示"无法确认结果"的错误文案。 */
  unknownPattern: RegExp
}

const MAX_REASON_LENGTH = 300

/** 提取可读的错误理由，超长截断，保持审计与文案稳定。 */
export function describeActionError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, MAX_REASON_LENGTH)
  if (typeof error === 'string') return error.slice(0, MAX_REASON_LENGTH)
  return String(error).slice(0, MAX_REASON_LENGTH)
}

/** 归类动作失败：只有能确认为前置失败时才算"未执行"，其余一律"结果未知"。 */
export function classifyActionFailure(
  error: unknown,
  rule: ActionFailureRule,
): { outcome: ActionFailureOutcome; reason: string } {
  const reason = describeActionError(error)
  const name = error instanceof Error ? error.name : ''
  const code = (error as NodeJS.ErrnoException | undefined)?.code

  // 中断与超时先判：这类错误发生时动作可能已经发出去了。
  if (name === 'TimeoutError' || name === 'AbortError') return { outcome: 'unknown', reason }
  if (typeof code === 'string' && rule.unknownCodes.includes(code)) return { outcome: 'unknown', reason }
  if (rule.unknownPattern.test(reason)) return { outcome: 'unknown', reason }
  if (typeof code === 'string' && rule.preActionCodes.includes(code)) return { outcome: 'not_applied', reason }
  if (rule.preActionPattern.test(reason)) return { outcome: 'not_applied', reason }
  // 拿不准就不假设没生效。
  return { outcome: 'unknown', reason }
}

/**
 * 生成工具结果文案。
 *
 * @param action 动作名，用于拼出模型能对应的前缀（如 `WebBridgeClick`）。
 * @param unknownHint 结果未知时的确认手段，必须说明"先做什么才能判断"。
 * @param classify 可选的归类的实现；需要额外判据（如 JSON-RPC 错误码）时传入，
 *   保证文案与归类结论一致，而不是各写一套。
 */
export function describeActionFailure(
  action: string,
  error: unknown,
  rule: ActionFailureRule,
  unknownHint: string,
  classify: (error: unknown) => { outcome: ActionFailureOutcome; reason: string } = (thrown) =>
    classifyActionFailure(thrown, rule),
): ActionFailure {
  const { outcome, reason } = classify(error)
  if (outcome === 'not_applied') {
    return { outcome, reason, message: `${action} 未执行（${reason}）：已确认动作没有生效，修正前置条件后可以重试。` }
  }
  return {
    outcome,
    reason,
    message: `${action} 结果未知（${reason}）：动作可能已经生效。禁止自动重试；${unknownHint}`,
  }
}

/** 派发后的异常不能仅凭错误码推断外部副作用未发生。 */
export function describeDispatchedActionFailure(action: string, error: unknown, hint: string): ActionFailure {
  const reason = describeActionError(error)
  return { outcome: 'unknown', reason, message: `${action} 结果未知（${reason}）：动作可能已经生效。禁止自动重试；${hint}` }
}
