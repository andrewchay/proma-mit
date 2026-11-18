import { randomUUID } from 'node:crypto'
import { getNewMediaRecord, listNewMediaRecords, putNewMediaRecord } from './new-media-sqlite-store'
import type { NewMediaContentDraft } from './content-operations'

interface DirectorBrand {
  id: string
  name: string
  brief: string
  revision: number
  createdAt: number
}

interface DirectorPlan {
  id: string
  brandId: string
  channel: string
  proposal: string
  brandSnapshot?: DirectorBrand
  status: 'proposed' | 'confirmed'
  createdAt: number
  confirmedAt?: number
}

function requiredText(value: string, label: string, maxLength = 20000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`${label}不能为空且不能超过 ${maxLength} 字符`)
  return value.trim()
}

export async function createDirectorBrand(name: string, brief: string, beforeWrite?: () => void): Promise<DirectorBrand> {
  return putNewMediaRecord('director-brand', { id: randomUUID(), name: requiredText(name, '品牌名称', 200), brief: requiredText(brief, '品牌简报'), revision: 1, createdAt: Date.now() }, beforeWrite)
}

export async function getDirectorBrand(brandId: string): Promise<DirectorBrand> {
  const brand = await getNewMediaRecord<DirectorBrand>('director-brand', requiredText(brandId, '品牌 ID', 100))
  if (!brand) throw new Error('品牌不存在')
  return brand
}

export async function updateDirectorBrand(brandId: string, name: string, brief: string, beforeWrite?: () => void): Promise<DirectorBrand> {
  const brand = await getDirectorBrand(brandId)
  return putNewMediaRecord('director-brand', { ...brand, name: requiredText(name, '品牌名称', 200), brief: requiredText(brief, '品牌简报'), revision: (brand.revision ?? 1) + 1 }, beforeWrite)
}

export async function listDirectorBrands(): Promise<DirectorBrand[]> {
  return listNewMediaRecords('director-brand')
}

export async function createDirectorPlan(brandId: string, channel: string, proposal: string, beforeWrite?: () => void): Promise<DirectorPlan> {
  const brandSnapshot = await getDirectorBrand(brandId)
  return putNewMediaRecord('director-plan', {
    id: randomUUID(), brandId, brandSnapshot, channel: requiredText(channel, '渠道', 100),
    proposal: requiredText(proposal, '方案'), status: 'proposed', createdAt: Date.now(),
  } satisfies DirectorPlan, beforeWrite)
}

export async function listDirectorPlans(brandId: string): Promise<DirectorPlan[]> {
  requiredText(brandId, '品牌 ID', 100)
  return (await listNewMediaRecords<DirectorPlan>('director-plan')).filter(plan => plan.brandId === brandId)
}

export async function getDirectorPlan(planId: string): Promise<DirectorPlan> {
  const plan = await getNewMediaRecord<DirectorPlan>('director-plan', requiredText(planId, '方案 ID', 100))
  if (!plan) throw new Error('方案不存在')
  return plan
}

export async function confirmDirectorPlan(planId: string, beforeWrite?: () => void): Promise<DirectorPlan> {
  const plan = await getDirectorPlan(planId)
  if (plan.status === 'confirmed') return plan
  return putNewMediaRecord('director-plan', { ...plan, status: 'confirmed', confirmedAt: Date.now() }, beforeWrite)
}

export async function createDirectorXiaohongshuDraft(input: { planId: string; title: string; body: string; hashtags: string[] }, beforeWrite?: () => void): Promise<NewMediaContentDraft> {
  const plan = await getNewMediaRecord<DirectorPlan>('director-plan', requiredText(input.planId, '方案 ID', 100))
  if (!plan || plan.status !== 'confirmed') throw new Error('请先确认方案，再制作内容')
  if (plan.channel !== 'xiaohongshu') throw new Error('当前方案不是小红书渠道')
  const title = requiredText(input.title, '标题', 200)
  const body = requiredText(input.body, '正文')
  if (!Array.isArray(input.hashtags) || input.hashtags.length > 30 || input.hashtags.some(tag => typeof tag !== 'string' || tag.length > 100)) throw new Error('话题标签无效')
  const draft: NewMediaContentDraft & { directorPlanId: string } = {
    directorPlanId: plan.id, id: randomUUID(), sourceText: body,
    platformCopies: { xiaohongshu: { title, body, hashtags: input.hashtags.map(tag => tag.trim()).filter(Boolean) } },
    createdAt: Date.now(),
  }
  return putNewMediaRecord('content-draft', draft, beforeWrite)
}

export async function createDirectorWechatDraft(input: { planId: string; title: string; body: string }, beforeWrite?: () => void): Promise<NewMediaContentDraft> {
  const plan = await getNewMediaRecord<DirectorPlan>('director-plan', requiredText(input.planId, '方案 ID', 100))
  if (!plan || plan.status !== 'confirmed') throw new Error('请先确认方案，再制作内容')
  if (plan.channel !== 'wechat-official-account') throw new Error('当前方案不是微信公众号渠道')
  const title = requiredText(input.title, '标题', 200)
  const body = requiredText(input.body, '正文')
  const draft: NewMediaContentDraft & { directorPlanId: string } = {
    directorPlanId: plan.id, id: randomUUID(), sourceText: body,
    platformCopies: { 'wechat-official-account': { title, body, hashtags: [] } }, createdAt: Date.now(),
  }
  return putNewMediaRecord('content-draft', draft, beforeWrite)
}

export async function saveDirectorRoleResult(input: { planId: string; role: 'copywriter' | 'designer'; task: string; result: string }, beforeWrite?: () => void) {
  return putNewMediaRecord('director-role-result', {
    id: randomUUID(), planId: input.planId, role: input.role, task: input.task,
    result: requiredText(input.result, '角色结果', 100000), createdAt: Date.now(),
  }, beforeWrite)
}

export async function listDirectorRoleResults(planId: string) {
  await getDirectorPlan(planId)
  const results = await listNewMediaRecords<{ id: string; planId: string; role: 'copywriter' | 'designer'; task: string; result: string; createdAt: number }>('director-role-result')
  return results.filter(result => result.planId === planId)
}
