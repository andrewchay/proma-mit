import type { AgentDefinition, PromaPermissionMode } from '@gravitas/shared'
import type { ToolContext } from '../agent-runtime/types'
import { loadCraftSections, resolveActiveDesignSystem, resolveDesignCraftDir } from '../design-context'
import { getDefaultSkillsDir, getWorkspaceSkillsDir } from '../config-paths'
import { getDirectorBrand, getDirectorPlan, saveDirectorRoleResult } from './director-workflow'
import { assertDirectorToolActive } from './director-tool-gate'

export type DirectorRole = 'copywriter' | 'designer'

export function isDirectorRoleAgent(name: string): boolean {
  return name === 'new-media-copywriter' || name === 'new-media-designer'
}

export function directorRolePermissionMode(name: string, parentMode: PromaPermissionMode): PromaPermissionMode {
  return isDirectorRoleAgent(name) ? 'safe' : parentMode
}

/** 角色属于新媒体插件；用户只与总监对话。 */
export function getDirectorRoleAgents(): Record<string, AgentDefinition> {
  return {
    'new-media-copywriter': {
      description: '新媒体文案：依据已确认的运营简报创作适配渠道的内容。',
      tools: [],
      prompt: '你是新媒体文案。依据总监提供的已确认方案与品牌资料创作标题、正文、话题与互动引导。区分事实与假设，不得虚构品牌、课程、价格、资质或效果。按渠道适配，不发布内容。返回可直接交付的正文与待核实事项。',
    },
    'new-media-designer': {
      description: '新媒体设计：依据已确认的方案、文案与 OpenDesign 参考制作视觉素材。',
      tools: [],
      prompt: '你是新媒体设计师。根据总监提供的品牌、文案和视觉需求，使用随任务提供的 OpenDesign 设计系统和工艺参考，制作适合渠道的封面及图文素材。返回一份完整 SVG 源码供总监保存：设置与渠道要求匹配的 viewBox，使用静态图形与文字；不要使用脚本、外部资源、内嵌图片、style 元素或 url()。标题中的数字与文字按自然阅读顺序排列，避免拆开词组或产生歧义；检查文字是否重叠、溢出或被图形遮挡。总监会将其渲染为 PNG。你没有工具，直接返回 SVG 源码，不得声称已生成文件；素材不足时明确说明，不得虚构授权或已完成的视觉效果。不要对外发布。',
    },
  }
}

/** 只允许对已确认方案调用角色；结果保留在本地供总监审核。 */
export async function delegateDirectorRole(input: { planId: string; role: DirectorRole; task: string }, ctx: ToolContext) {
  const plan = await getDirectorPlan(input.planId)
  if (plan.status !== 'confirmed') throw new Error('方案尚未确认，不能开始制作')
  if (input.role !== 'copywriter' && input.role !== 'designer') throw new Error('角色无效')
  if (typeof input.task !== 'string' || !input.task.trim() || input.task.length > 10000) throw new Error('任务内容无效')
  if (!ctx.runSubAgent) throw new Error('当前会话无法委派独立角色，请检查运行时支持')
  const brand = plan.brandSnapshot ?? await getDirectorBrand(plan.brandId)
  let designContext = ''
  if (input.role === 'designer') {
    const design = resolveActiveDesignSystem(ctx.cwd, ctx.workspaceSlug)
    const craftDir = resolveDesignCraftDir({ workspaceSlug: ctx.workspaceSlug, getWorkspaceSkillsDir, getDefaultSkillsDir })
    const craft = loadCraftSections(craftDir, ['typography', 'color', 'anti-ai-slop'])
    designContext = [
      design ? `OpenDesign 设计系统 ${design.title}：\n${design.body}\n设计令牌：\n${design.tokensCss ?? '未提供 tokens.css'}` : '<od_missing_resource>未找到当前品牌设计系统，请明确说明并与用户确认视觉方向。</od_missing_resource>',
      craft.body ? `OpenDesign 工艺参考：\n${craft.body}` : '<od_missing_resource>未找到设计工艺参考。</od_missing_resource>',
      'SVG 不支持 style 或 CSS 变量，请从设计令牌中取值并写入 SVG 元素属性。',
    ].join('\n\n')
  }
  const task = [
    `品牌：${brand.name}\n品牌简报：\n${brand.brief}`,
    `渠道：${plan.channel}\n用户已确认的方案：\n${plan.proposal}`,
    `本次任务：\n${input.task.trim()}`,
    input.role === 'designer' && plan.channel === 'xiaohongshu' ? '小红书首版封面使用 1080 × 1440，viewBox 为 0 0 1080 1440。' : '',
    input.role === 'designer' && plan.channel !== 'xiaohongshu' ? '根据目标渠道和用户要求决定画布尺寸；当前仅支持小红书封面交接。' : '',
    designContext,
  ].filter(Boolean).join('\n\n')
  const result = await ctx.runSubAgent({
    agentName: input.role === 'copywriter' ? 'new-media-copywriter' : 'new-media-designer',
    task, abortSignal: ctx.abortSignal,
  })
  if (ctx.abortSignal?.aborted) throw new Error('任务已取消，未保存角色结果')
  if (typeof result !== 'string' || !result.trim() || result.trim() === '子代理已完成任务，但未返回文本结果') throw new Error('角色未返回有效结果')
  const { runGuardedToolCall } = await import('../agent-runtime/tool-scheduler-service')
  return runGuardedToolCall({
    tool: roleResultWrite, args: { planId: plan.id }, ctx, signal: ctx.abortSignal,
    execute: () => { assertDirectorToolActive(ctx); return saveDirectorRoleResult({ planId: plan.id, role: input.role, task: input.task.trim(), result }, () => assertDirectorToolActive(ctx)) },
  })
}

const roleResultWrite = {
  name: 'nm_internal_role_result_write', description: '保存新媒体角色交付',
  parameters: { type: 'object' as const, properties: {} },
  execute: async () => ({ toolCallId: '', content: '' }),
}
