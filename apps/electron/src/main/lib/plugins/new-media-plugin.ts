import type { RuntimeToolDefinition } from '../agent-runtime/types'
import type { BuiltinPluginRuntime } from '../plugin-manager'
import type { PluginSkillContribution } from '@gravitas/shared'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getNewMediaSkillsDir, parseSkillVersion } from '../config-paths'
import { createContentDraft, getPublicationJob, schedulePublication, type NewMediaPlatform } from '../new-media/content-operations'
import { createListeningQuery, createReplyDraft, getListeningDigest, ingestEngagement, listEngagements } from '../new-media/community-listening'
import { getSocialReport, getTrendOpportunities, ingestMetricSnapshot, ingestTrend } from '../new-media/analytics-trends'
import { approveControlledAction, getControlledActionAudit, requestControlledAction, simulateControlledAction } from '../new-media/controlled-actions'

const NEW_MEDIA_SKILLS = ['nm-content-operator', 'nm-community-manager', 'nm-social-listening', 'nm-social-reporting', 'nm-trend-radar', 'nm-controlled-outbound'] as const
const DEFAULT_ENABLED_CAPABILITIES: readonly string[] = []

/**
 * 运行时能力开关（P4-13）：在订阅能力之上叠加 kill switch。
 * 被关闭的能力即使已订阅，也不注入工具与 Skill，实现按平台/账号快速回滚。
 */
function isCapabilityKilled(capability: string): boolean {
  try {
    const { isCapabilityActive, listCapabilityFlags } = require('../new-media/new-media-feature-flags') as {
      isCapabilityActive: (scope: { capability: string }, flags: unknown[]) => boolean
      listCapabilityFlags: () => Promise<unknown[]>
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

function contentTools(): RuntimeToolDefinition[] {
  const tools: RuntimeToolDefinition[] = [
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
        name: 'nm_approve_controlled_action',
        description: '批准一个本地外发请求。批准不等于真实发布或发送；仍需后续受控执行。',
        parameters: { type: 'object', properties: { action_id: { type: 'string' }, approver: { type: 'string' } }, required: ['action_id', 'approver'] },
        execute: async (input) => {
          const args = (input ?? {}) as Record<string, unknown>
          try { return { toolCallId: '', content: JSON.stringify(await approveControlledAction(String(args.action_id ?? ''), String(args.approver ?? '')), null, 2) } }
          catch (error) { return { toolCallId: '', content: error instanceof Error ? error.message : '批准外发请求失败', isError: true } }
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
  return tools
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
    contributePrompts: () => isNewMediaEnabled() ? ['新媒体运营工具只会创建本地草稿、账号占位、待审批发布排程和受控外发请求。当前 PlatformAdapter 不联网且不支持真实授权；不得声称账号已连接或内容已发布。任何未来外部授权、发布或回复必须经用户明确确认并由受控执行器处理。'] : [],
    contributeSkills,
  }
}
