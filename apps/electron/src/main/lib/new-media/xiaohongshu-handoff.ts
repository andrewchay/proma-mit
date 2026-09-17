import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import AdmZip from 'adm-zip'
import type {
  NewMediaContentDraft,
  XiaohongshuHandoff,
  XiaohongshuHandoffAuditEntry,
} from '@gravitas/shared'
import type { NewMediaAuditEntry } from './new-media-audit'
import { appendNewMediaAudit, createNewMediaAuditEntry, listNewMediaAudit } from './new-media-audit'
import { getNewMediaRecord, listNewMediaRecords } from './new-media-sqlite-store'

const DRAFT_KIND = 'content-draft'
const HANDOFF_KIND = 'xiaohongshu-handoff'

/** 发布交接审计统一写入 new-media-audit，读取时映射回既有形状。 */
function audit(handoffId: string, event: XiaohongshuHandoffAuditEntry['event'], actor: string, detail: string, metadata?: Record<string, unknown>) {
  return createNewMediaAuditEntry({ domain: 'handoff', event, actor, subjectId: handoffId, detail, metadata })
}

async function persistHandoff(record: XiaohongshuHandoff, entry: Promise<NewMediaAuditEntry>): Promise<void> {
  await appendNewMediaAudit(await entry, [{ kind: HANDOFF_KIND, value: record }])
}

function safeName(title: string): string {
  const value = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return (value || 'xiaohongshu-draft').slice(0, 48)
}

async function requireHandoff(handoffId: string): Promise<XiaohongshuHandoff> {
  const value = await getNewMediaRecord<XiaohongshuHandoff>(HANDOFF_KIND, handoffId)
  if (!value) throw new Error('小红书发布交接不存在')
  return value
}

async function requireDraft(draftId: string): Promise<NewMediaContentDraft> {
  const draft = await getNewMediaRecord<NewMediaContentDraft>(DRAFT_KIND, draftId)
  if (!draft) throw new Error('内容草稿不存在')
  if (!draft.platformCopies.xiaohongshu) throw new Error('草稿不包含小红书版本')
  return draft
}

export async function prepareXiaohongshuHandoff(draftId: string): Promise<XiaohongshuHandoff> {
  const draft = await requireDraft(draftId)
  const existing = (await listNewMediaRecords<XiaohongshuHandoff>(HANDOFF_KIND)).find((item) => item.draftId === draftId)
  if (existing) return existing
  const copy = draft.platformCopies.xiaohongshu!
  const now = Date.now()
  const handoff: XiaohongshuHandoff = {
    id: randomUUID(),
    draftId,
    status: 'draft_ready',
    packageVersion: 1,
    packageFileName: `${safeName(copy.title)}-小红书交付包.zip`,
    warnings: ['当前草稿未关联封面或媒体素材，请在小红书发布页补充并核验。'],
    createdAt: now,
    updatedAt: now,
  }
  await persistHandoff(handoff, audit(handoff.id, 'prepared', 'local-user', '已准备小红书发布交接；尚未对外发布。', {
    draftId: handoff.draftId,
    packageVersion: handoff.packageVersion,
    warningCount: handoff.warnings.length,
  }))
  return handoff
}

export async function listXiaohongshuHandoffs(): Promise<XiaohongshuHandoff[]> {
  return listNewMediaRecords(HANDOFF_KIND)
}

export async function buildXiaohongshuHandoffPackage(handoffId: string): Promise<Buffer> {
  const handoff = await requireHandoff(handoffId)
  const draft = await requireDraft(handoff.draftId)
  const copy = draft.platformCopies.xiaohongshu!
  const content = [copy.title, '', copy.body, '', copy.hashtags.join(' ')].join('\n').trimEnd() + '\n'
  const manifest = {
    schemaVersion: 1,
    platform: 'xiaohongshu',
    draftId: draft.id,
    handoffId: handoff.id,
    generatedAt: new Date().toISOString(),
    files: ['content.txt', 'content.json', 'README.md'],
    warnings: handoff.warnings,
    publicationSemantics: '该文件仅表示本地发布交接，不代表内容已在小红书发布。',
  }
  const readme = [
    '# 小红书发布交付包',
    '',
    '1. 打开小红书官方 App 或创作后台。',
    '2. 复制 `content.txt` 中的标题、正文和标签。',
    '3. 补充并核验封面、图片或视频素材。',
    '4. 由账号操作者检查后手动确认发布。',
    '',
    '本交付包不会登录账号、调用私有接口或自动发布。',
  ].join('\n')
  const zip = new AdmZip()
  zip.addFile('content.txt', Buffer.from(content, 'utf-8'))
  zip.addFile('content.json', Buffer.from(JSON.stringify({ title: copy.title, body: copy.body, hashtags: copy.hashtags }, null, 2), 'utf-8'))
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'))
  zip.addFile('README.md', Buffer.from(readme, 'utf-8'))
  return zip.toBuffer()
}

export async function exportXiaohongshuHandoff(handoffId: string, destinationPath: string, actor = 'local-user'): Promise<XiaohongshuHandoff> {
  if (!destinationPath.trim()) throw new Error('导出路径不能为空')
  const handoff = await requireHandoff(handoffId)
  if (handoff.status === 'user_confirmed_published') throw new Error('已确认发布的交接不能重新导出')
  const buffer = await buildXiaohongshuHandoffPackage(handoffId)
  writeFileSync(destinationPath, buffer)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const exported: XiaohongshuHandoff = {
    ...handoff,
    status: 'handed_off',
    packageFileName: basename(destinationPath),
    packageSha256: sha256,
    handedOffAt: Date.now(),
    handedOffBy: actor,
    updatedAt: Date.now(),
  }
  await persistHandoff(exported, audit(handoff.id, 'exported', actor, `已导出交付包 ${exported.packageFileName}；未发生真实发布。`, {
    draftId: exported.draftId,
    packageFileName: exported.packageFileName,
    packageSha256: sha256,
    destinationIsCustomPath: basename(destinationPath) !== exported.packageFileName,
  }))
  return exported
}

export async function confirmXiaohongshuPublished(handoffId: string, actor: string): Promise<XiaohongshuHandoff> {
  const handoff = await requireHandoff(handoffId)
  const confirmedBy = actor.trim()
  if (!confirmedBy) throw new Error('确认人不能为空')
  if (handoff.status === 'draft_ready') throw new Error('必须先完成发布交接，才能由用户确认已发布')
  if (handoff.status === 'user_confirmed_published') return handoff
  const confirmed: XiaohongshuHandoff = {
    ...handoff,
    status: 'user_confirmed_published',
    confirmedAt: Date.now(),
    confirmedBy,
    updatedAt: Date.now(),
  }
  await persistHandoff(confirmed, audit(handoff.id, 'user_confirmed_published', confirmedBy, '由用户确认内容已在小红书发布；该状态不是平台 API 回执。', {
    draftId: handoff.draftId,
    confirmationSource: 'user',
  }))
  return confirmed
}

export async function getXiaohongshuHandoffAudit(handoffId: string): Promise<XiaohongshuHandoffAuditEntry[]> {
  const order = ['prepared', 'exported', 'user_confirmed_published']
  const entries = await listNewMediaAudit({ domain: 'handoff', subjectId: handoffId })
  return entries
    .map((entry) => ({
      id: entry.id,
      handoffId: entry.subjectId,
      event: entry.event as XiaohongshuHandoffAuditEntry['event'],
      actor: entry.actor,
      detail: entry.detail,
      createdAt: entry.createdAt,
    }))
    .sort((left, right) => order.indexOf(left.event) - order.indexOf(right.event))
}
