import type { SDKResultMessage } from '@gravitas/shared'
import type { PilotCommandSettlement } from './project-pilot-budget-ledger'

/** Pilot 终态成功至少需要可归属的 Runtime 费用结果；Pi 尚无此结果链。 */
export function getPilotCompletionBlocker(
  pilotCommandId: string | undefined,
  employeeRuntime: string | undefined,
  runtimeSource: string,
  result?: SDKResultMessage,
): string | undefined {
  if (!pilotCommandId) return undefined
  if (!employeeRuntime || runtimeSource !== employeeRuntime) return 'Pilot 终态 Runtime 来源与员工配置不一致，不能报告完成'
  if (employeeRuntime === 'pi') return 'Pi Pilot 尚无可核验的终态费用证据，不能报告完成'
  const cost = result?.total_cost_usd
  const input = result?.usage?.input_tokens
  const output = result?.usage?.output_tokens
  if (cost === undefined || !Number.isFinite(cost) || cost < 0
    || input === undefined || !Number.isSafeInteger(input) || input < 0
    || output === undefined || !Number.isSafeInteger(output) || output < 0) {
    return 'Pilot 终态缺少可结算的 Runtime 费用结果，不能报告完成'
  }
  return undefined
}

/** 成功回写须以同一命令已落账且未待对账为前提。 */
export function getPilotSettlementBlocker(
  pilotCommandId: string | undefined,
  settlement: PilotCommandSettlement | null,
): string | undefined {
  if (!pilotCommandId) return undefined
  if (!settlement || settlement.commandId !== pilotCommandId || settlement.state !== 'settled' || settlement.grantPaused) {
    return 'Pilot 终态费用未完成可归属结算，不能报告完成'
  }
  return undefined
}
