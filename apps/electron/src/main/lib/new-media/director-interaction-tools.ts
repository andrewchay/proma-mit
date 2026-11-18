import type { RuntimeToolDefinition, ToolContext } from '../agent-runtime/types'
import { getDirectorBrand, getDirectorPlan, confirmDirectorPlan } from './director-workflow'
import { delegateDirectorRole } from './director-roles'
import { assertDirectorToolActive } from './director-tool-gate'

/** 用户交互期间不占用共享资源锁，确认后单独串行化数据库写入。 */
export async function executeDirectorConfirm(input: unknown, ctx: ToolContext) {
  try {
    assertDirectorToolActive(ctx)
    const plan = await getDirectorPlan(String((input as Record<string, unknown> | undefined)?.plan_id ?? ''))
    if (plan.status === 'confirmed') return { toolCallId: '', content: JSON.stringify(plan) }
    if (!ctx.onAskUser || !ctx.abortSignal) throw new Error('当前会话无法请求用户确认，方案仍未确认')
    const brand = plan.brandSnapshot ?? await getDirectorBrand(plan.brandId)
    const question = `请确认品牌简报和${plan.channel}方案，确认后才开始制作：\n\n品牌：${brand.name}\n${brand.brief}\n\n方案：\n${plan.proposal}`
    const answer = await ctx.onAskUser({ questions: [{ question, header: '确认运营方案', options: [{ label: '确认并开始制作' }, { label: '需要修改' }] }] }, ctx.abortSignal)
    if (answer.behavior !== 'allow' || (answer.answers[question] ?? answer.answers['0']) !== '确认并开始制作' || ctx.abortSignal.aborted) throw new Error('方案尚未确认，请根据用户反馈修改')
    const { runGuardedToolCall } = await import('../agent-runtime/tool-scheduler-service')
    const saved = await runGuardedToolCall({ tool: confirmationWrite, args: { planId: plan.id }, ctx, signal: ctx.abortSignal, execute: () => { assertDirectorToolActive(ctx); return confirmDirectorPlan(plan.id, () => assertDirectorToolActive(ctx)) } })
    return { toolCallId: '', content: JSON.stringify(saved) }
  } catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '确认方案失败', isError: true } }
}

/** 等待角色期间不占用共享资源锁；结果写入由角色服务单独调度。 */
export async function executeDirectorDelegate(input: unknown, ctx: ToolContext) {
  const args = (input ?? {}) as Record<string, unknown>
  try {
    assertDirectorToolActive(ctx)
    if (args.role !== 'copywriter' && args.role !== 'designer') throw new Error('角色无效')
    const output = await delegateDirectorRole({ planId: typeof args.plan_id === 'string' ? args.plan_id : '', role: args.role, task: typeof args.task === 'string' ? args.task : '' }, ctx)
    return { toolCallId: '', content: JSON.stringify(output) }
  } catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '角色任务失败', isError: true } }
}

const confirmationWrite: RuntimeToolDefinition = {
  name: 'nm_internal_confirm_plan_write', description: '保存用户对方案的确认',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ toolCallId: '', content: '' }),
}
