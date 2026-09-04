/** 预算预估目录执行绑定：复用已验证的业务实现。 */

import type { ToolCall } from '@gravitas/core'
import { executeBudgetForecastTool } from '../../../../src/main/lib/marketing/ma-tools/budget-forecast'

export async function execute(input: unknown) {
  return executeBudgetForecastTool({ id: 'directory-ma-forecast-budget', name: 'ma_forecast_budget', arguments: (input ?? {}) as Record<string, unknown> } as ToolCall)
}
