import type { OwnerExecutionAutonomousScheduleStatus } from '@gravitas/shared'

export interface OwnerRecoveryGuidance {
  title: string
  actions: string[]
  caution: string
}

/** 从权威调度状态给出只读处理建议；不改变授权、预算或运行状态。 */
export function deriveOwnerRecoveryGuidance(status: OwnerExecutionAutonomousScheduleStatus): OwnerRecoveryGuidance {
  if (status.state === 'needs_reconcile') return {
    title: '先完成费用与运行对账',
    actions: [
      status.role
        ? `检查 ${status.role} 命令、启动回执、逐请求预留和 Provider 控制台用量。`
        : '检查授权下所有未结命令、启动回执、逐请求预留和 Provider 控制台用量。',
      '如存在未解决停止升级，先核验停止证据；只有确认未发送/未计费后，才可使用对应命令的独立对账入口。',
    ],
    caution: '停止或费用仍不确定时保留占额并升级人工处理；不要重试、释放占额或把未知费用按零处理。',
  }
  if (status.state === 'stale') return {
    title: '来源已变化，先重新核对范围',
    actions: ['刷新目标、计划、任务与角色配置。', '审阅新的范围和验收标准；需要执行时重新准备并取得对应版本的授权。'],
    caution: '旧准备和旧授权不会自动沿用，不会自动续派。',
  }
  if (status.state === 'paused' || status.state === 'expired' || status.state === 'archived') return {
    title: '授权不可继续派发',
    actions: ['核对授权状态、到期时间和未结命令。', '需要继续时，先解决未结项，再按当前目标与计划重新走授权预览。'],
    caution: '不会复活旧授权或释放未知占额。',
  }
  if (status.state === 'no_grant') return {
    title: '当前没有可用授权',
    actions: ['核对当前项目目标与准备范围。', '如需自主执行，先完成准备、复核并取得新的明确授权。'],
    caution: '不会自行创建授权或派发命令。',
  }
  if (status.state === 'manual') return {
    title: '当前授权为手动执行模式',
    actions: ['按手动流程检查并启动已准备的命令。', '如需自主调度，需基于当前范围重新准备并明确选择该模式。'],
    caution: '不会把手动授权转换为自主执行。',
  }
  if (status.nextAction === 'await_business_acceptance') return {
    title: '请审阅交付并作业务验收',
    actions: ['查看冻结标准、执行回报和技术评审。', '逐项核对真实成果后再决定验收或提出修改意见。'],
    caution: '技术评审通过不等于业务验收；系统不会替你确认。',
  }
  if (status.reviewVerdict === 'blocked' || status.nextAction === 'human_decision') return {
    title: '需要人工决定后再继续',
    actions: ['先查看具体阻塞原因、评审发现和来源版本。', '必要时修订目标/计划或授权并重新核验；若证据不完整，补齐证据后再决定。'],
    caution: '不会因人工处理建议而自动重试、扩大范围或创建新命令。',
  }
  if (status.state === 'ready') return {
    title: '等待已授权命令按流程启动',
    actions: ['核对待执行角色、命令确认和授权剩余额度。', '仅通过对应命令的确认与派发流程继续。'],
    caution: '本建议不会代替确认或启动命令。',
  }
  if (status.state === 'running') return {
    title: '命令正在运行',
    actions: ['查看当前角色、运行回报和费用结算状态。', '等待运行与结算证据收敛后再处理下一步。'],
    caution: '不会并行重跑或提前释放预留额度。',
  }
  if (status.nextAction === 'none') return {
    title: '当前没有自动执行的下一步',
    actions: ['查看原因、命令记录和任务状态。', '若业务目标仍未完成，先由负责人决定是否更新范围或准备新的执行。'],
    caution: '不会自动创建命令或扩大授权。',
  }
  return {
    title: '按当前调度状态处理',
    actions: ['查看原因、命令记录和当前任务/角色。', '只有状态与授权都明确有效时才执行显示的下一步。'],
    caution: '此建议不执行任何操作，也不改变费用或授权状态。',
  }
}
