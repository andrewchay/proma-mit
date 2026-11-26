import type { RuntimeToolDefinition } from '../agent-runtime/types'
import type { BuiltinPluginRuntime } from '../plugin-manager'
import type { PluginSkillContribution } from '@gravitas/shared'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getNewMediaSkillsDir, parseSkillVersion } from '../config-paths'
import { createContentDraft, getPublicationJob, schedulePublication, type NewMediaPlatform } from '../new-media/content-operations'
import { createListeningQuery, createReplyDraft, getListeningDigest, ingestEngagement, listEngagements } from '../new-media/community-listening'
import { getSocialReport, getTrendOpportunities, ingestMetricSnapshot, ingestTrend } from '../new-media/analytics-trends'
import { getControlledActionAudit, requestControlledAction, simulateControlledAction } from '../new-media/controlled-actions'
import { createDirectorBrand, updateDirectorBrand, listDirectorBrands, createDirectorPlan, listDirectorPlans, createDirectorXiaohongshuDraft, createDirectorWechatDraft, listDirectorRoleResults } from '../new-media/director-workflow'
import { executeDirectorConfirm, executeDirectorDelegate } from '../new-media/director-interaction-tools'
import { saveDirectorDesign } from '../new-media/director-design'
import { assertDirectorToolActive } from '../new-media/director-tool-gate'
import { executeXiaohongshuDraftTakeover } from '../new-media/xiaohongshu-draft-takeover'

const NEW_MEDIA_SKILLS = ['nm-content-operator', 'nm-community-manager', 'nm-social-listening', 'nm-social-reporting', 'nm-trend-radar', 'nm-controlled-outbound'] as const
const DEFAULT_ENABLED_CAPABILITIES: readonly string[] = []

/**
 * 运行时能力开关（P4-13）：在订阅能力之上叠加 kill switch。
 * 被关闭的能力即使已订阅，也不注入工具与 Skill，实现按平台/账号快速回滚。
 */
function isCapabilityKilled(capability: string): boolean {
  try {
    const { isCapabilityActive } = require('../new-media/new-media-feature-flags') as {
      isCapabilityActive: (scope: { capability: string }, flags: unknown[]) => boolean
    }
    // 插件加载阶段拿不到异步存储，这里同步读取在初始化时缓存的开关快照。
    const { getCachedCapabilityFlags } = require('../new-media/new-media-feature-flags') as { getCachedCapabilityFlags: () => unknown[] }
    const flags = getCachedCapabilityFlags()
    return !isCapabilityActive({ capability }, flags)
  } catch {
    // 开关系统不可用时按「未关闭」处理，不放大故障面。
    return false
  }
}

function readCapabilities(): string[] {
  try {
    const { getSettings } = require('../settings-service') as { getSettings: () => { newMediaCapabilities?: string[]; domainCapabilities?: string[] } }
    const settings = getSettings()
    const own = Array.isArray(settings.newMediaCapabilities) ? settings.newMediaCapabilities : []
    const domains = Array.isArray(settings.domainCapabilities) ? settings.domainCapabilities : []
    return [...new Set([...own, ...domains])]
    .filter((capability) => ['content-operations', 'community-operations', 'social-listening', 'social-analytics', 'trend-radar', 'controlled-outbound'].includes(capability))
    .filter((capability) => !isCapabilityKilled(capability))
  } catch {
    return [...DEFAULT_ENABLED_CAPABILITIES]
  }
}

export function isNewMediaEnabled(capabilities = readCapabilities()): boolean {
  return capabilities.length > 0
}

export function hasNewMediaContentCapability(): boolean {
  return readCapabilities().includes('content-operations')
}

function hasCapability(capability: string): boolean {
  return readCapabilities().includes(capability)
}

function contributeSkills(): PluginSkillContribution[] {
  if (!isNewMediaEnabled()) return []
  const sourceDir = getNewMediaSkillsDir()
  const domains: Record<(typeof NEW_MEDIA_SKILLS)[number], string> = {
    'nm-content-operator': 'content-operations',
    'nm-community-manager': 'community-operations',
    'nm-social-listening': 'social-listening',
    'nm-social-reporting': 'social-analytics',
    'nm-trend-radar': 'trend-radar',
    'nm-controlled-outbound': 'controlled-outbound',
  }
  return NEW_MEDIA_SKILLS.filter((slug) => hasCapability(domains[slug])).flatMap((slug) => {
    const sourcePath = join(sourceDir, slug)
    return existsSync(sourcePath) ? [{ slug, domain: domains[slug], sourcePath, version: parseSkillVersion(sourcePath) }] : []
  })
}

function isPlatform(value: unknown): value is NewMediaPlatform {
  return value === 'xiaohongshu' || value === 'wechat-official-account'
}

const HASHTAGS_PARAMETER = { type: 'array', description: '话题标签字符串数组', items: { type: 'string' } }

function contentTools(): RuntimeToolDefinition[] {
  const tools: RuntimeToolDefinition[] = [
    {
      name: 'nm_director_xhs_draft_takeover',
      description: '用户明确要求暂存小红书时，为已审核并打开在官方创作窗口中的草稿请求 Computer Use 用户接管。用户亲自暂存、重开草稿，之后本工具核对文案。草稿 ID 来自保存文案工具。',
      parameters: { type: 'object', properties: { draft_id: { type: 'string' } }, required: ['draft_id'] },
      execute: executeXiaohongshuDraftTakeover,
    },
    {
      name: 'nm_director_delegate',
      description: '向文案或设计角色委派已确认方案的制作任务，并保存真实返回结果。未确认时不调用角色。设计会提供可用的 OpenDesign 品牌和工艺参考。',
      parameters: { type: 'object', properties: { plan_id: { type: 'string' }, role: { type: 'string', enum: ['copywriter', 'designer'] }, task: { type: 'string' } }, required: ['plan_id', 'role', 'task'] },
      execute: executeDirectorDelegate,
    },
    {
      name: 'nm_director_list_role_results',
      description: '读取方案下已保存的文案和设计角色结果，不会触发新任务。',
      parameters: { type: 'object', properties: { plan_id: { type: 'string' } }, required: ['plan_id'] },
      execute: async (input) => {
        try { return { toolCallId: '', content: JSON.stringify(await listDirectorRoleResults(String((input as Record<string, unknown> | undefined)?.plan_id ?? ''))) } }
        catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '读取结果失败', isError: true } }
      },
    },
    {
      name: 'nm_director_brand',
      description: '创建、更新或列出本地品牌简报。简报应区分用户提供的事实、待确认假设和品牌视觉要求，不记录凭据。已创建的方案保留当时品牌快照。',
      parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['create', 'update', 'list'] }, brand_id: { type: 'string' }, name: { type: 'string' }, brief: { type: 'string' } }, required: ['operation'] },
      execute: async (input, ctx) => {
        const args = (input ?? {}) as Record<string, unknown>
        try {
          if (args.operation === 'list') return { toolCallId: '', content: JSON.stringify(await listDirectorBrands()) }
          if (args.operation === 'update') return { toolCallId: '', content: JSON.stringify(await updateDirectorBrand(String(args.brand_id ?? ''), String(args.name ?? ''), String(args.brief ?? ''), () => assertDirectorToolActive(ctx))) }
          if (args.operation !== 'create') throw new Error('操作无效')
          return { toolCallId: '', content: JSON.stringify(await createDirectorBrand(String(args.name ?? ''), String(args.brief ?? ''), () => assertDirectorToolActive(ctx))) }
        } catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '品牌操作失败', isError: true } }
      },
    },
    {
      name: 'nm_director_plan',
      description: '创建或列出品牌运营方案。创建后必须先展示给用户并等待用户明确确认；方案渠道使用 xiaohongshu 或其他渠道标识。',
      parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['create', 'list'] }, brand_id: { type: 'string' }, channel: { type: 'string' }, proposal: { type: 'string' } }, required: ['operation', 'brand_id'] },
      execute: async (input, ctx) => {
        const args = (input ?? {}) as Record<string, unknown>
        try {
          const brandId = String(args.brand_id ?? '')
          if (args.operation === 'list') return { toolCallId: '', content: JSON.stringify(await listDirectorPlans(brandId)) }
          if (args.operation !== 'create') throw new Error('操作无效')
          return { toolCallId: '', content: JSON.stringify(await createDirectorPlan(brandId, String(args.channel ?? ''), String(args.proposal ?? ''), () => assertDirectorToolActive(ctx))) }
        } catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '方案操作失败', isError: true } }
      },
    },
    {
      name: 'nm_director_confirm_plan',
      description: '展示保存的具体方案并向用户发起确认；仅用户明确选择确认后记录。用户要求修改时需新建方案并重新确认。',
      parameters: { type: 'object', properties: { plan_id: { type: 'string' } }, required: ['plan_id'] },
      execute: executeDirectorConfirm,
    },
    {
      name: 'nm_director_save_design',
      description: '为已确认方案的小红书或公众号草稿保存设计角色创作的 SVG，并渲染为可预览的 PNG。SVG 必须有 viewBox，不允许脚本、外部资源、内嵌图片、style 或 url()。仅保存本地文件，不会发布。',
      parameters: { type: 'object', properties: { draft_id: { type: 'string' }, svg: { type: 'string' } }, required: ['draft_id', 'svg'] },
      execute: async (input, ctx) => {
        const args = (input ?? {}) as Record<string, unknown>
        try {
          const asset = await saveDirectorDesign(typeof args.draft_id === 'string' ? args.draft_id : '', typeof args.svg === 'string' ? args.svg : '', undefined, ctx)
          return { toolCallId: '', content: JSON.stringify({ assetId: asset.id, draftId: asset.draftId, message: '已保存 SVG 和 PNG；请在新媒体工作台预览、审核后准备交接。' }) }
        } catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '保存设计失败', isError: true } }
      },
    },
    {
      name: 'nm_director_save_wechat_copy',
      description: '将已确认方案制作的公众号标题和正文保存为本地草稿，需在工作台选择账号并同步到微信草稿箱，不会发布。',
      parameters: { type: 'object', properties: { plan_id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['plan_id', 'title', 'body'] },
      execute: async (input, ctx) => {
        const args = (input ?? {}) as Record<string, unknown>
        try {
          return { toolCallId: '', content: JSON.stringify(await createDirectorWechatDraft({ planId: String(args.plan_id ?? ''), title: String(args.title ?? ''), body: String(args.body ?? '') }, () => assertDirectorToolActive(ctx))) }
        } catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '保存公众号草稿失败', isError: true } }
      },
    },
    {
      name: 'nm_director_save_xiaohongshu_copy',
      description: '将已确认方案制作的实际小红书标题、正文和标签保存为本地草稿，可在新媒体工作台准备人工发布交接。不会生成图片或发布。',
      parameters: { type: 'object', properties: { plan_id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, hashtags: HASHTAGS_PARAMETER }, required: ['plan_id', 'title', 'body', 'hashtags'] },
      execute: async (input, ctx) => {
        const args = (input ?? {}) as Record<string, unknown>
        try {
          if (!Array.isArray(args.hashtags) || args.hashtags.some(tag => typeof tag !== 'string')) throw new Error('话题标签无效')
          return { toolCallId: '', content: JSON.stringify(await createDirectorXiaohongshuDraft({ planId: String(args.plan_id ?? ''), title: String(args.title ?? ''), body: String(args.body ?? ''), hashtags: args.hashtags as string[] }, () => assertDirectorToolActive(ctx))) }
        } catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '保存草稿失败', isError: true } }
      },
    },
    {
      name: 'nm_create_content_draft',
      description: '把一份原始内容适配为小红书和公众号的待审核草稿。仅创建本地草稿，不会发布或发送到外部平台。',
      parameters: {
        type: 'object',
        properties: {
          source_text: { type: 'string', description: '待适配的原始内容' },
          platforms: { type: 'array', description: '目标平台列表：xiaohongshu、wechat-official-account' },
        },
        required: ['source_text', 'platforms'],
      },
      execute: async (input) => {
        const args = (input ?? {}) as Record<string, unknown>
        const sourceText = typeof args.source_text === 'string' ? args.source_text : ''
        const platforms = Array.isArray(args.platforms) ? args.platforms.filter(isPlatform) : []
        try {
          const draft = await createContentDraft(sourceText, platforms)
          return { toolCallId: '', content: JSON.stringify({ status: 'draft_created', draft }, null, 2) }
        } catch (error) {
          return { toolCallId: '', content: error instanceof Error ? error.message : '创建草稿失败', isError: true }
        }
      },
    },
    {
      name: 'nm_schedule_publication',
      description: '为已创建的内容草稿建立待审批发布排程。该操作不会发布内容；所有外部发布都必须经过单独审批与执行。',
      parameters: {
        type: 'object',
        properties: {
          draft_id: { type: 'string', description: '草稿 ID' },
          platform: { type: 'string', enum: ['xiaohongshu', 'wechat-official-account'], description: '发布平台' },
          account_id: { type: 'string', description: '已连接账号的标识，不接受密码或令牌' },
          scheduled_at: { type: 'number', description: '未来发布时间的 Unix 毫秒时间戳' },
        },
        required: ['draft_id', 'platform', 'account_id', 'scheduled_at'],
      },
      execute: async (input) => {
        const args = (input ?? {}) as Record<string, unknown>
        if (!isPlatform(args.platform)) return { toolCallId: '', content: '发布平台无效', isError: true }
        try {
          const job = await schedulePublication({
            draftId: typeof args.draft_id === 'string' ? args.draft_id : '',
            platform: args.platform,
            accountId: typeof args.account_id === 'string' ? args.account_id : '',
            scheduledAt: typeof args.scheduled_at === 'number' ? args.scheduled_at : Number.NaN,
          })
          return { toolCallId: '', content: JSON.stringify({ status: 'pending_approval', job, message: '已创建待审批排程，尚未向平台发布。' }, null, 2) }
        } catch (error) {
          return { toolCallId: '', content: error instanceof Error ? error.message : '创建排程失败', isError: true }
        }
      },
    },
    {
      name: 'nm_get_publication_status',
      description: '查询本地发布排程的审批状态与基础信息，不会访问外部平台。',
      parameters: { type: 'object', properties: { job_id: { type: 'string', description: '发布排程 ID' } }, required: ['job_id'] },
      execute: async (input) => {
        const jobId = typeof (input as Record<string, unknown> | undefined)?.job_id === 'string' ? String((input as Record<string, unknown>).job_id) : ''
        const job = await getPublicationJob(jobId)
        return job
          ? { toolCallId: '', content: JSON.stringify({ status: job.status, job }, null, 2) }
          : { toolCallId: '', content: '发布排程不存在', isError: true }
      },
    },
  ]

  if (hasCapability('community-operations')) {
    tools.push(
      {
        name: 'nm_ingest_engagement',
        description: '导入一条已获得授权读取的评论或私信，并在本地进行意图、情感和优先级分流；不会对外回复。',
        parameters: { type: 'object', properties: { platform: { type: 'string', enum: ['xiaohongshu', 'wechat-official-account'] }, channel: { type: 'string', enum: ['comment', 'direct-message'] }, author: { type: 'string' }, text: { type: 'string' } }, required: ['platform', 'channel', 'author', 'text'] },
        execute: async (input) => {
          const args = (input ?? {}) as Record<string, unknown>
          if (!isPlatform(args.platform) || (args.channel !== 'comment' && args.channel !== 'direct-message')) return { toolCallId: '', content: '平台或互动渠道无效', isError: true }
          try {
            return { toolCallId: '', content: JSON.stringify(await ingestEngagement({ platform: args.platform, channel: args.channel, author: String(args.author ?? ''), text: String(args.text ?? '') }), null, 2) }
          } catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '导入互动失败', isError: true } }
        },
      },
      {
        name: 'nm_list_engagement',
        description: '列出本地互动收件箱，支持按优先级筛选；不会读取未授权的平台数据。',
        parameters: { type: 'object', properties: { priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] } } },
        execute: async (input) => {
          const priority = (input as Record<string, unknown> | undefined)?.priority
          return { toolCallId: '', content: JSON.stringify(await listEngagements(priority === 'low' || priority === 'normal' || priority === 'high' || priority === 'urgent' ? priority : undefined), null, 2) }
        },
      },
      {
        name: 'nm_draft_reply',
        description: '为低风险互动生成仅供人工审核的本地回复草稿。投诉和商务合作会被升级给人工，不能自动生成或发送回复。',
        parameters: { type: 'object', properties: { engagement_id: { type: 'string' } }, required: ['engagement_id'] },
        execute: async (input) => {
          try { return { toolCallId: '', content: JSON.stringify(await createReplyDraft(String((input as Record<string, unknown> | undefined)?.engagement_id ?? '')), null, 2) } }
          catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '创建回复草稿失败', isError: true } }
        },
      },
    )
  }

  if (hasCapability('social-listening')) {
    tools.push(
      {
        name: 'nm_create_listening_query',
        description: '创建本地品牌或竞品关键词监听任务。该工具不自行抓取平台，也不绕过平台权限。',
        parameters: { type: 'object', properties: { keywords: { type: 'array', description: '需要监控的关键词列表' } }, required: ['keywords'] },
        execute: async (input) => {
          const rawKeywords = (input as Record<string, unknown> | undefined)?.keywords
          const keywords = Array.isArray(rawKeywords) ? rawKeywords.filter((value): value is string => typeof value === 'string') : []
          try { return { toolCallId: '', content: JSON.stringify(await createListeningQuery(keywords), null, 2) } }
          catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '创建监听任务失败', isError: true } }
        },
      },
      {
        name: 'nm_get_listening_digest',
        description: '读取本地监听任务的声量、情感和高风险提及摘要。',
        parameters: { type: 'object', properties: { query_id: { type: 'string' } }, required: ['query_id'] },
        execute: async (input) => {
          try { return { toolCallId: '', content: JSON.stringify(await getListeningDigest(String((input as Record<string, unknown> | undefined)?.query_id ?? '')), null, 2) } }
          catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '读取监听摘要失败', isError: true } }
        },
      },
    )
  }
  if (hasCapability('social-analytics')) {
    tools.push(
      {
        name: 'nm_ingest_metric_snapshot',
        description: '导入已授权来源的内容指标快照，用于本地运营汇总；不会自行访问平台或修改外部数据。',
        parameters: { type: 'object', properties: { platform: { type: 'string', enum: ['xiaohongshu', 'wechat-official-account'] }, content_id: { type: 'string' }, captured_at: { type: 'number' }, impressions: { type: 'number' }, engagements: { type: 'number' }, followers_gained: { type: 'number' } }, required: ['platform', 'content_id', 'captured_at', 'impressions', 'engagements', 'followers_gained'] },
        execute: async (input) => {
          const args = (input ?? {}) as Record<string, unknown>
          if (!isPlatform(args.platform)) return { toolCallId: '', content: '发布平台无效', isError: true }
          try {
            return { toolCallId: '', content: JSON.stringify(await ingestMetricSnapshot({ platform: args.platform, contentId: String(args.content_id ?? ''), capturedAt: Number(args.captured_at), impressions: Number(args.impressions), engagements: Number(args.engagements), followersGained: Number(args.followers_gained) }), null, 2) }
          } catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '导入指标失败', isError: true } }
        },
      },
      {
        name: 'nm_get_social_report',
        description: '生成指定时间范围内的本地跨平台运营汇总，包括曝光、互动率和新增粉丝；不将相关性解释为真实交易 ROI。',
        parameters: { type: 'object', properties: { period_start: { type: 'number' }, period_end: { type: 'number' } }, required: ['period_start', 'period_end'] },
        execute: async (input) => {
          const args = (input ?? {}) as Record<string, unknown>
          try { return { toolCallId: '', content: JSON.stringify(await getSocialReport(Number(args.period_start), Number(args.period_end)), null, 2) } }
          catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '生成报告失败', isError: true } }
        },
      },
    )
  }

  if (hasCapability('trend-radar')) {
    tools.push(
      {
        name: 'nm_ingest_trend',
        description: '导入一个已授权或人工核验的热点条目，保存热度、来源、关联关键词与风险等级；不会自行抓取热榜。',
        parameters: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, source: { type: 'string' }, observed_at: { type: 'number' }, heat: { type: 'number' }, related_keywords: { type: 'array', description: '热点关联关键词' }, risk: { type: 'string', enum: ['low', 'medium', 'high'] } }, required: ['title', 'summary', 'source', 'observed_at', 'heat', 'related_keywords', 'risk'] },
        execute: async (input) => {
          const args = (input ?? {}) as Record<string, unknown>
          const keywords = Array.isArray(args.related_keywords) ? args.related_keywords.filter((value): value is string => typeof value === 'string') : []
          if (args.risk !== 'low' && args.risk !== 'medium' && args.risk !== 'high') return { toolCallId: '', content: '风险等级无效', isError: true }
          try { return { toolCallId: '', content: JSON.stringify(await ingestTrend({ title: String(args.title ?? ''), summary: String(args.summary ?? ''), source: String(args.source ?? ''), observedAt: Number(args.observed_at), heat: Number(args.heat), relatedKeywords: keywords, risk: args.risk }), null, 2) } }
          catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '导入热点失败', isError: true } }
        },
      },
      {
        name: 'nm_get_trend_opportunities',
        description: '基于本地热点与品牌关键词生成相关性、风险和行动建议；输出是运营判断，不保证热点效果。',
        parameters: { type: 'object', properties: { brand_keywords: { type: 'array', description: '品牌或产品关键词' } }, required: ['brand_keywords'] },
        execute: async (input) => {
          const rawKeywords = (input as Record<string, unknown> | undefined)?.brand_keywords
          const keywords = Array.isArray(rawKeywords) ? rawKeywords.filter((value): value is string => typeof value === 'string') : []
          try { return { toolCallId: '', content: JSON.stringify(await getTrendOpportunities(keywords), null, 2) } }
          catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '生成热点建议失败', isError: true } }
        },
      },
    )
  }
  if (hasCapability('controlled-outbound')) {
    tools.push(
      {
        name: 'nm_request_controlled_action',
        description: '创建小红书或公众号的待审批发布/回复请求。只创建本地审批记录，不会连接账号、不发布也不发送消息。',
        parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['publish', 'send-reply'] }, platform: { type: 'string', enum: ['xiaohongshu', 'wechat-official-account'] }, target_id: { type: 'string' }, summary: { type: 'string' } }, required: ['kind', 'platform', 'target_id', 'summary'] },
        execute: async (input) => {
          const args = (input ?? {}) as Record<string, unknown>
          if (!isPlatform(args.platform) || (args.kind !== 'publish' && args.kind !== 'send-reply')) return { toolCallId: '', content: '操作类型或平台无效', isError: true }
          try { return { toolCallId: '', content: JSON.stringify(await requestControlledAction({ kind: args.kind, platform: args.platform, targetId: String(args.target_id ?? ''), summary: String(args.summary ?? '') }), null, 2) } }
          catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '创建外发审批请求失败', isError: true } }
        },
      },
      {
        name: 'nm_simulate_controlled_action',
        description: '对已批准的外发请求生成本地模拟回执。当前版本绝不会访问真实平台、浏览器或账号。',
        parameters: { type: 'object', properties: { action_id: { type: 'string' } }, required: ['action_id'] },
        execute: async (input) => {
          try { return { toolCallId: '', content: JSON.stringify(await simulateControlledAction(String((input as Record<string, unknown> | undefined)?.action_id ?? '')), null, 2) } }
          catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '模拟外发失败', isError: true } }
        },
      },
      {
        name: 'nm_get_controlled_action_audit',
        description: '查询本地外发审批请求的审计链路，包含申请、批准和模拟回执；不含敏感凭据。',
        parameters: { type: 'object', properties: { action_id: { type: 'string' } }, required: ['action_id'] },
        execute: async (input) => ({ toolCallId: '', content: JSON.stringify(await getControlledActionAudit(String((input as Record<string, unknown> | undefined)?.action_id ?? '')), null, 2) }),
      },
    )
  }
  return tools.flatMap(tool => {
    if (!tool.name.startsWith('nm_director_')) return [tool]
    if (!hasNewMediaContentCapability()) return []
    // 等待型入口保留函数身份，以便调度器只信任对应实现。
    if (tool.execute === executeDirectorConfirm || tool.execute === executeDirectorDelegate || tool.execute === executeXiaohongshuDraftTakeover) return [tool]
    return [{ ...tool, execute: async (input: unknown, ctx: import('../agent-runtime/types').ToolContext) => {
      try { assertDirectorToolActive(ctx); return await tool.execute(input, ctx) }
      catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '新媒体能力不可用', isError: true } }
    } }]
  })
}

export function newMediaPluginRuntime(): BuiltinPluginRuntime {
  return {
    manifest: {
      schemaVersion: 1,
      id: 'com.gravitas.new-media',
      version: '0.1.0',
      name: '新媒体运营',
      description: '提供内容适配、互动聆听、运营洞察与受控外发审批；当前版本不会连接真实账号或自动对外发布。',
      publisher: 'Proma',
      platforms: ['darwin', 'win32', 'linux'],
      activationEvents: ['onAppReady'],
      subscriptions: [],
      surfaces: ['agent-tools', 'agent-skills', 'bridge-connector'],
      permissions: {},
      entrypoints: {},
    },
    isEnabled: () => isNewMediaEnabled(),
    setEnabled: async () => true,
    isSupported: () => true,
    contributeTools: contentTools,
    contributePrompts: () => isNewMediaEnabled() ? [
      '新媒体工具的本地草稿、排程与模拟回执不代表已经发布。任何真实外发必须经用户明确确认并取得真实平台回执。',
      ...(hasNewMediaContentCapability() ? [
        '用户要求新媒体总监时，负责品牌、策略和统筹。使用 nm_director_brand 保存品牌简报，使用 nm_director_plan 保存具体方案并调用 nm_director_confirm_plan 等待用户确认；确认后调用 nm_director_delegate 分别委派 copywriter 和 designer，将文案结果传给设计角色。小红书文案用 nm_director_save_xiaohongshu_copy 保存；公众号文案用 nm_director_save_wechat_copy 保存。再用 nm_director_save_design 保存设计角色生成的 SVG 并渲染 PNG；向用户展示结果，提示在工作台预览和交接。若角色或设计素材不可用须如实说明，不得声称完成发布。',
        '用户明确要求暂存小红书草稿时，先请用户在工作台预览并准备交接，打开官方创作窗口、上传封面并填入文案。接着用 nm_director_xhs_draft_takeover 暂停并交给用户操作，收到工具核对结果后再报告。发布由用户在平台操作。',
      ] : []),
    ] : [],
    contributeSkills,
  }
}
