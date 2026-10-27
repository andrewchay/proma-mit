/** 平台启动成功不代表 Owner 业务链通过；按本轮模式检查真实结果。 */
import { OWNER_2048_SMOKE_CHECKS } from '../apps/electron/src/main/lib/owner-2048-smoke-contract'
export function assertOwnerSmokeResult(raw: unknown, mode: string): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Owner 冒烟缺少结构化结果')
  const report = raw as Record<string, unknown>
  const reviewer = report.reviewer as Record<string, unknown> | undefined
  const failures: string[] = []
  if (report.status !== 'completed') failures.push('员工执行未成功完成')
  if (!reviewer || reviewer.recorded !== true || reviewer.verdict !== 'approved') failures.push('没有已保存且通过的独立评审')
  if (mode === 'development' || mode === 'project-2048') {
    if (!Array.isArray(report.validations) || report.validations.length === 0
      || report.validations.some((value: unknown) => !value || typeof value !== 'object' || (value as Record<string, unknown>).status !== 'passed')) {
      failures.push('正式研发验证未全部通过')
    }
  }
  if (mode === 'project-2048') {
    if (report.ownerQualityState !== 'accepted') failures.push('Owner未完成真实质量验收')
    if (report.deliveryState !== 'delivered') failures.push('原项目对话没有准确版本交付')
    const plan = report.ownerPlan as Record<string, unknown> | undefined
    const assignment = report.ownerAssignment as Record<string, unknown> | undefined
    if (!plan?.confirmed || plan.generatedByOwner !== true || !assignment?.reviewerChosen) failures.push('真实Owner规划或派工未完成')
    const checks = report.checks as Array<{ id?: string; status?: string }> | undefined
    if (!Array.isArray(checks) || checks.length !== OWNER_2048_SMOKE_CHECKS.length
      || OWNER_2048_SMOKE_CHECKS.some(id => checks.filter(check => check.id === id && check.status === 'passed').length !== 1)) {
      failures.push('2048七项行为检查未完整通过')
    }
  }
  if (failures.length) throw new Error(`Owner 业务冒烟未通过：${failures.join('；')}`)
}
