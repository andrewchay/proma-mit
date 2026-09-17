/**
 * 新媒体运营 IPC 处理器注册。
 *
 * 独立成模块的原因：仅依赖 new-media 领域服务与 electron，便于在被测与打包场景
 * 单独注册和校验，不会把营销、项目管理等无关重模块拉进依赖闭包。
 * 所有入参先经 new-media-ipc-validation 校验，再进入服务层。
 */

import type { WebContents } from 'electron'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { NEW_MEDIA_IPC_CHANNELS } from '@gravitas/shared'
import { withNewMediaIpcValidation } from './new-media-ipc-validation'

export function registerNewMediaIpcHandlers(): void {
  // 所有入参先经 new-media-ipc-validation 校验，再进入服务层。
  const nmValidation = () => import('./new-media-ipc-validation')
  /**
   * 统一包装：校验错误以 `new_media:<code>:<field>` 形式抛出，
   * 渲染进程可按稳定错误码分支，无需解析自由文本。
   */
  const handle = (channel: string, listener: (event: { sender: WebContents }, ...args: never[]) => Promise<unknown>): void => {
    ipcMain.handle(channel, (event, ...args) => withNewMediaIpcValidation(() => listener(event, ...(args as never[]))))
  }

  handle(NEW_MEDIA_IPC_CHANNELS.LIST_DRAFTS, async () => {
    const { listContentDrafts } = await import('./content-operations')
    return listContentDrafts()
  })
  handle(NEW_MEDIA_IPC_CHANNELS.CREATE_DRAFT, async (_: unknown, sourceText: unknown, platforms: unknown) => {
    const v = await nmValidation()
    const text = v.requireRichText(sourceText, 'sourceText', v.NEW_MEDIA_LIMITS.sourceText)
    const list = v.requireStringArray(platforms, 'platforms', { maxItems: 2, maxItemLength: 32 })
    for (const platform of list) v.requirePlatform(platform)
    const { createContentDraft } = await import('./content-operations')
    return createContentDraft(text, list as import('@gravitas/shared').NewMediaPlatform[])
  })
  handle(NEW_MEDIA_IPC_CHANNELS.LIST_PUBLICATION_JOBS, async () => {
    const { listPublicationJobs } = await import('./content-operations')
    return listPublicationJobs()
  })
  handle(NEW_MEDIA_IPC_CHANNELS.SCHEDULE_PUBLICATION, async (_: unknown, input: unknown) => {
    const v = await nmValidation()
    const payload = v.assertPlainObject(input, 'input')
    const draftId = v.requireId(payload.draftId, 'draftId')
    const platform = v.requirePlatform(payload.platform)
    const accountId = v.requireId(payload.accountId, 'accountId')
    const scheduledAt = v.requireFutureTimestamp(payload.scheduledAt, 'scheduledAt')
    const { schedulePublication } = await import('./content-operations')
    return schedulePublication({ draftId, platform: platform as import('@gravitas/shared').NewMediaPlatform, accountId, scheduledAt })
  })
  handle(NEW_MEDIA_IPC_CHANNELS.LIST_ENGAGEMENTS, async () => (await import('./community-listening')).listEngagements())
  handle(NEW_MEDIA_IPC_CHANNELS.INGEST_ENGAGEMENT, async (_: unknown, input: unknown) => {
    const v = await nmValidation()
    const payload = v.assertPlainObject(input, 'input')
    const platform = v.requirePlatform(payload.platform)
    const channel = v.requireEnum(payload.channel, ['comment', 'direct-message'] as const, 'channel')
    const author = v.requireString(payload.author, 'author', v.NEW_MEDIA_LIMITS.shortText)
    const text = v.requireRichText(payload.text, 'text', v.NEW_MEDIA_LIMITS.bodyText)
    return (await import('./community-listening')).ingestEngagement({ platform: platform as import('@gravitas/shared').NewMediaPlatform, channel, author, text })
  })
  handle(NEW_MEDIA_IPC_CHANNELS.CREATE_REPLY_DRAFT, async (_: unknown, engagementId: unknown) => {
    const { requireId } = await nmValidation()
    return (await import('./community-listening')).createReplyDraft(requireId(engagementId, 'engagementId'))
  })
  handle(NEW_MEDIA_IPC_CHANNELS.LIST_LISTENING_QUERIES, async () => (await import('./community-listening')).listListeningQueries())
  handle(NEW_MEDIA_IPC_CHANNELS.CREATE_LISTENING_QUERY, async (_: unknown, keywords: unknown) => {
    const v = await nmValidation()
    return (await import('./community-listening')).createListeningQuery(v.requireStringArray(keywords, 'keywords'))
  })
  handle(NEW_MEDIA_IPC_CHANNELS.LIST_MENTIONS, async (_: unknown, queryId: unknown) => {
    const { optionalId } = await nmValidation()
    return (await import('./community-listening')).listMentions(optionalId(queryId, 'queryId'))
  })
  handle(NEW_MEDIA_IPC_CHANNELS.INGEST_MENTION, async (_: unknown, input: unknown) => {
    const v = await nmValidation()
    const payload = v.assertPlainObject(input, 'input')
    const queryId = v.requireId(payload.queryId, 'queryId')
    const platform = v.requirePlatform(payload.platform)
    const sourceUrl = v.requireHttpUrl(payload.sourceUrl, 'sourceUrl')
    const text = v.requireRichText(payload.text, 'text', v.NEW_MEDIA_LIMITS.bodyText)
    return (await import('./community-listening')).ingestMention({ queryId, platform: platform as import('@gravitas/shared').NewMediaPlatform, sourceUrl, text })
  })
  handle(NEW_MEDIA_IPC_CHANNELS.GET_LISTENING_DIGEST, async (_: unknown, queryId: unknown) => {
    const { requireId } = await nmValidation()
    return (await import('./community-listening')).getListeningDigest(requireId(queryId, 'queryId'))
  })
  handle(NEW_MEDIA_IPC_CHANNELS.LIST_METRIC_SNAPSHOTS, async () => (await import('./analytics-trends')).listMetricSnapshots())
  handle(NEW_MEDIA_IPC_CHANNELS.INGEST_METRIC_SNAPSHOT, async (_: unknown, input: unknown) => {
    const v = await nmValidation()
    const payload = v.assertPlainObject(input, 'input')
    return (await import('./analytics-trends')).ingestMetricSnapshot({
      platform: v.requirePlatform(payload.platform) as import('@gravitas/shared').NewMediaPlatform,
      contentId: v.requireId(payload.contentId, 'contentId'),
      capturedAt: v.requireTimestamp(payload.capturedAt, 'capturedAt'),
      impressions: v.requireFiniteNumber(payload.impressions, 'impressions', { min: 0 }),
      engagements: v.requireFiniteNumber(payload.engagements, 'engagements', { min: 0 }),
      followersGained: v.requireFiniteNumber(payload.followersGained, 'followersGained', { min: 0 }),
    })
  })
  handle(NEW_MEDIA_IPC_CHANNELS.GET_SOCIAL_REPORT, async (_: unknown, periodStart: unknown, periodEnd: unknown) => {
    const v = await nmValidation()
    return (await import('./analytics-trends')).getSocialReport(
      v.requireTimestamp(periodStart, 'periodStart'),
      v.requireTimestamp(periodEnd, 'periodEnd'),
    )
  })
  handle(NEW_MEDIA_IPC_CHANNELS.LIST_TRENDS, async () => (await import('./analytics-trends')).listTrends())
  handle(NEW_MEDIA_IPC_CHANNELS.INGEST_TREND, async (_: unknown, input: unknown) => {
    const v = await nmValidation()
    const payload = v.assertPlainObject(input, 'input')
    return (await import('./analytics-trends')).ingestTrend({
      title: v.requireString(payload.title, 'title', v.NEW_MEDIA_LIMITS.shortText),
      summary: v.requireRichText(payload.summary, 'summary', v.NEW_MEDIA_LIMITS.summary),
      source: v.requireString(payload.source, 'source', v.NEW_MEDIA_LIMITS.shortText),
      observedAt: v.requireTimestamp(payload.observedAt, 'observedAt'),
      heat: v.requireFiniteNumber(payload.heat, 'heat', { min: 0, max: 100 }),
      risk: v.requireEnum(payload.risk, ['low', 'medium', 'high'] as const, 'risk'),
      relatedKeywords: v.requireStringArray(payload.relatedKeywords, 'relatedKeywords', { allowEmpty: true }),
    })
  })
  handle(NEW_MEDIA_IPC_CHANNELS.GET_TREND_OPPORTUNITIES, async (_: unknown, keywords: unknown) => {
    const { requireStringArray } = await nmValidation()
    return (await import('./analytics-trends')).getTrendOpportunities(requireStringArray(keywords, 'keywords'))
  })

  handle(NEW_MEDIA_IPC_CHANNELS.LIST_CONTROLLED_ACTIONS, async () => {
    const { listControlledActions } = await import('./controlled-actions')
    return listControlledActions()
  })
  handle(NEW_MEDIA_IPC_CHANNELS.REQUEST_CONTROLLED_ACTION, async (_: unknown, input: unknown) => {
    const v = await nmValidation()
    const payload = v.assertPlainObject(input, 'input')
    return (await import('./controlled-actions')).requestControlledAction({
      kind: v.requireEnum(payload.kind, ['publish', 'send-reply'] as const, 'kind'),
      platform: v.requirePlatform(payload.platform) as import('@gravitas/shared').NewMediaPlatform,
      targetId: v.requireId(payload.targetId, 'targetId'),
      summary: v.requireString(payload.summary, 'summary', v.NEW_MEDIA_LIMITS.summary),
    })
  })
  handle(NEW_MEDIA_IPC_CHANNELS.APPROVE_CONTROLLED_ACTION, async (_: unknown, actionId: unknown, approver: unknown) => {
    const v = await nmValidation()
    return (await import('./controlled-actions')).approveControlledAction(
      v.requireId(actionId, 'actionId'),
      v.requireString(approver, 'approver', v.NEW_MEDIA_LIMITS.shortText),
    )
  })
  handle(NEW_MEDIA_IPC_CHANNELS.REJECT_CONTROLLED_ACTION, async (_: unknown, actionId: unknown, actor: unknown, reason: unknown) => {
    const v = await nmValidation()
    return (await import('./controlled-actions')).rejectControlledAction(
      v.requireId(actionId, 'actionId'),
      v.requireString(actor, 'actor', v.NEW_MEDIA_LIMITS.shortText),
      v.requireRichText(reason, 'reason', v.NEW_MEDIA_LIMITS.summary),
    )
  })
  handle(NEW_MEDIA_IPC_CHANNELS.SIMULATE_CONTROLLED_ACTION, async (_: unknown, actionId: unknown) => {
    const { requireId } = await nmValidation()
    return (await import('./controlled-actions')).simulateControlledAction(requireId(actionId, 'actionId'))
  })
  handle(NEW_MEDIA_IPC_CHANNELS.GET_CONTROLLED_ACTION_AUDIT, async (_: unknown, actionId: unknown) => {
    const { requireId } = await nmValidation()
    return (await import('./controlled-actions')).getControlledActionAudit(requireId(actionId, 'actionId'))
  })

  // ===== 受控外发真实执行门控（P2-06） =====
  // 只有 approved 状态可以进入执行；执行器缺失时保持 approved 并明确报错。
  handle(NEW_MEDIA_IPC_CHANNELS.LIST_CONTROLLED_EXECUTORS, async () => (await import('./new-media-controlled-executor')).listControlledActionExecutors())

  handle(NEW_MEDIA_IPC_CHANNELS.EXECUTE_CONTROLLED_ACTION, async (_: unknown, actionId: unknown) => {
    const { requireId } = await nmValidation()
    return (await import('./controlled-actions')).executeControlledAction(requireId(actionId, 'actionId'))
  })

  handle(NEW_MEDIA_IPC_CHANNELS.RECONCILE_CONTROLLED_EXECUTION, async (_: unknown, input: unknown) => {
    const v = await nmValidation()
    const payload = v.assertPlainObject(input, 'input')
    const actionId = v.requireId(payload.actionId, 'actionId')
    const actor = v.requireString(payload.actor, 'actor', v.NEW_MEDIA_LIMITS.shortText)
    const note = v.requireRichText(payload.note, 'note', v.NEW_MEDIA_LIMITS.summary)
    if (typeof payload.platformAccepted !== 'boolean') throw new Error('platformAccepted 必须是布尔值')
    return (await import('./controlled-actions')).reconcileControlledExecution(actionId, { actor, note, platformAccepted: payload.platformAccepted })
  })

  handle(NEW_MEDIA_IPC_CHANNELS.RETRY_CONTROLLED_EXECUTION, async (_: unknown, actionId: unknown) => {
    const { requireId } = await nmValidation()
    return (await import('./controlled-actions')).retryControlledExecution(requireId(actionId, 'actionId'))
  })

  handle(NEW_MEDIA_IPC_CHANNELS.LIST_ACCOUNTS, async () => (await import('./new-media-account-service')).listNewMediaAccounts())
  handle(NEW_MEDIA_IPC_CHANNELS.CREATE_ACCOUNT, async (_: unknown, input: unknown) => {
    const v = await nmValidation()
    const payload = v.assertPlainObject(input, 'input')
    return (await import('./new-media-account-service')).createNewMediaAccount({
      platform: v.requirePlatform(payload.platform) as import('@gravitas/shared').NewMediaPlatform,
      displayName: v.requireString(payload.displayName, 'displayName', v.NEW_MEDIA_LIMITS.shortText),
    })
  })
  handle(NEW_MEDIA_IPC_CHANNELS.BEGIN_ACCOUNT_AUTHORIZATION, async (_: unknown, accountId: unknown) => {
    const { requireId } = await nmValidation()
    return (await import('./new-media-account-service')).beginNewMediaAccountAuthorization(requireId(accountId, 'accountId'))
  })
  handle(NEW_MEDIA_IPC_CHANNELS.VALIDATE_ACCOUNT, async (_: unknown, accountId: unknown) => {
    const { requireId } = await nmValidation()
    return (await import('./new-media-account-service')).validateNewMediaAccount(requireId(accountId, 'accountId'))
  })
  handle(NEW_MEDIA_IPC_CHANNELS.DISCONNECT_ACCOUNT, async (_: unknown, accountId: unknown) => {
    const { requireId } = await nmValidation()
    return (await import('./new-media-account-service')).disconnectNewMediaAccount(requireId(accountId, 'accountId'))
  })
  handle(NEW_MEDIA_IPC_CHANNELS.REMOVE_ACCOUNT, async (_: unknown, accountId: unknown) => {
    const { requireId } = await nmValidation()
    return (await import('./new-media-account-service')).removeNewMediaAccount(requireId(accountId, 'accountId'))
  })
  handle(NEW_MEDIA_IPC_CHANNELS.GET_ACCOUNT_AUDIT, async (_: unknown, accountId: unknown) => {
    const { requireId } = await nmValidation()
    return (await import('./new-media-account-service')).getNewMediaAccountAudit(requireId(accountId, 'accountId'))
  })
  handle(NEW_MEDIA_IPC_CHANNELS.GET_ADAPTER_INFO, async (_: unknown, platform: unknown) => {
    const { requirePlatform } = await nmValidation()
    const resolved = requirePlatform(platform) as import('@gravitas/shared').NewMediaPlatform
    const { adapterInfo } = await import('./platform-adapter')
    const { getPlatformAdapterRegistry } = await import('./platform-adapter-registry')
    return adapterInfo(getPlatformAdapterRegistry().get(resolved))
  })
  handle(NEW_MEDIA_IPC_CHANNELS.GET_SCHEMA_INFO, async () => (await import('./new-media-sqlite-store')).getNewMediaSchemaInfo())

  // 只读：返回账号最近一次能力协商结果与账号档案（均不含凭据）。
  // AppSecret 等敏感材料不经过渲染进程，因此没有对应的写入通道。
  handle(NEW_MEDIA_IPC_CHANNELS.GET_ACCOUNT_CAPABILITIES, async (_: unknown, accountId: unknown) => {
    const { requireId } = await nmValidation()
    const resolved = requireId(accountId, 'accountId')
    const service = await import('./new-media-account-service')
    return {
      capabilities: await service.getNewMediaAccountCapabilityStates(resolved),
      profile: await service.getNewMediaAccountProfile(resolved) ?? null,
    }
  })

  handle(NEW_MEDIA_IPC_CHANNELS.LIST_XHS_HANDOFFS, async () => (await import('./xiaohongshu-handoff')).listXiaohongshuHandoffs())
  handle(NEW_MEDIA_IPC_CHANNELS.PREPARE_XHS_HANDOFF, async (_: unknown, draftId: unknown) => {
    return (await import('./xiaohongshu-handoff')).prepareXiaohongshuHandoff((await nmValidation()).requireId(draftId, 'draftId'))
  })
  handle(NEW_MEDIA_IPC_CHANNELS.EXPORT_XHS_HANDOFF, async (event, handoffId: unknown) => {
    const resolvedHandoffId = (await nmValidation()).requireId(handoffId, 'handoffId')
    const service = await import('./xiaohongshu-handoff')
    const handoff = (await service.listXiaohongshuHandoffs()).find((item) => item.id === resolvedHandoffId)
    if (!handoff) throw new Error('小红书发布交接不存在')
    const owner = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
    const options = {
      title: '导出小红书发布交付包',
      defaultPath: handoff.packageFileName,
      filters: [{ name: 'ZIP 交付包', extensions: ['zip'] }],
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { canceled: true }
    const exported = await service.exportXiaohongshuHandoff(resolvedHandoffId, result.filePath)
    return { canceled: false, fileName: exported.packageFileName, sha256: exported.packageSha256 }
  })
  handle(NEW_MEDIA_IPC_CHANNELS.CONFIRM_XHS_PUBLISHED, async (_: unknown, handoffId: unknown, actor: unknown) => {
    const v = await nmValidation()
    return (await import('./xiaohongshu-handoff')).confirmXiaohongshuPublished(
      v.requireId(handoffId, 'handoffId'),
      v.requireString(actor, 'actor', v.NEW_MEDIA_LIMITS.shortText),
    )
  })
  handle(NEW_MEDIA_IPC_CHANNELS.GET_XHS_HANDOFF_AUDIT, async (_: unknown, handoffId: unknown) => {
    const { requireId } = await nmValidation()
    return (await import('./xiaohongshu-handoff')).getXiaohongshuHandoffAudit(requireId(handoffId, 'handoffId'))
  })

  // ===== 小红书官方报表导入（无平台网络请求） =====
  handle(NEW_MEDIA_IPC_CHANNELS.LIST_IMPORT_CONTRACTS, async () => (await import('./new-media-import-contract')).NEW_MEDIA_IMPORT_CONTRACTS)

  handle(NEW_MEDIA_IPC_CHANNELS.PICK_REPORT_FILE, async (event, input: unknown) => {
    const v = await nmValidation()
    const payload = v.assertPlainObject(input, 'input')
    const sourceKind = v.requireEnum(payload.sourceKind, ['xiaohongshu-professional', 'xiaohongshu-pugongying', 'xiaohongshu-juguang'] as const, 'sourceKind')
    const accountId = v.requireId(payload.accountId, 'accountId')
    const owner = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
    return (await import('./new-media-import-ipc')).pickAndPreviewReportFile({ sourceKind, accountId, owner })
  })

  handle(NEW_MEDIA_IPC_CHANNELS.CANCEL_IMPORT_PREVIEW, async (_: unknown, token: unknown) => {
    const { requireId } = await nmValidation()
    ;(await import('./new-media-import-ipc')).clearPendingImport(requireId(token, 'token'))
  })

  handle(NEW_MEDIA_IPC_CHANNELS.COMMIT_REPORT_IMPORT, async (_: unknown, input: unknown) => {
    const v = await nmValidation()
    const payload = v.assertPlainObject(input, 'input')
    const token = v.requireId(payload.token, 'token')
    const confirmed = payload.confirmed === true
    const allowDuplicateFile = payload.allowDuplicateFile === true
    const importedBy = v.requireString(payload.importedBy, 'importedBy', v.NEW_MEDIA_LIMITS.shortText)
    const ipc = await import('./new-media-import-ipc')
    const entry = ipc.takePendingImport(token)
    if (!entry) throw new Error('导入预览已过期，请重新选择文件')
    try {
      return await (await import('./new-media-report-import')).commitNewMediaImport({
        sourceKind: entry.sourceKind,
        accountId: entry.accountId,
        parsed: entry.parsed,
        importedBy,
        confirmed,
        allowDuplicateFile,
      })
    } finally {
      ipc.clearPendingImport(token)
    }
  })

  handle(NEW_MEDIA_IPC_CHANNELS.LIST_IMPORT_BATCHES, async () => (await import('./new-media-report-import')).listNewMediaImportBatches())

  handle(NEW_MEDIA_IPC_CHANNELS.LIST_IMPORTED_ROWS, async (_: unknown, batchId: unknown) => {
    const { optionalId } = await nmValidation()
    return (await import('./new-media-report-import')).listNewMediaImportedRows(optionalId(batchId, 'batchId'))
  })

  handle(NEW_MEDIA_IPC_CHANNELS.GET_INSIGHT_REPORT, async (_: unknown, periodStart: unknown, periodEnd: unknown) => {
    const v = await nmValidation()
    return (await import('./new-media-insight-report')).getNewMediaInsightReport({
      periodStart: v.requireTimestamp(periodStart, 'periodStart'),
      periodEnd: v.requireTimestamp(periodEnd, 'periodEnd'),
    })
  })
}
