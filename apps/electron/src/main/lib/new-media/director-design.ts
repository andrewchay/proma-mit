import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getNewMediaDir } from '../config-paths'
import { getNewMediaRecord, listNewMediaRecords, putNewMediaRecord } from './new-media-sqlite-store'
import { getDirectorPlan } from './director-workflow'
import { renderDirectorSvg, validateDirectorSvg } from './director-design-renderer'
import { withDirectorDraftLock } from './director-draft-lock'
import type { ToolContext } from '../agent-runtime/types'
import { assertDirectorToolActive } from './director-tool-gate'

interface DirectorDesignAsset {
  id: string
  draftId: string
  planId: string
  version: number
  pngSha256: string
  svgSha256: string
  createdAt: number
}

interface DirectorDraft { id: string; directorPlanId?: string }
const ASSET_KIND = 'director-design-asset'
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function assetPath(id: string, extension: 'png' | 'svg'): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('设计素材标识无效')
  return join(getNewMediaDir(), 'director-assets', `${id}.${extension}`)
}

export async function saveDirectorDesign(draftId: string, svg: string, render = renderDirectorSvg, ctx?: ToolContext): Promise<DirectorDesignAsset> {
  return withDirectorDraftLock(draftId, () => saveDirectorDesignLocked(draftId, svg, render, ctx))
}

async function saveDirectorDesignLocked(draftId: string, svg: string, render: typeof renderDirectorSvg, ctx?: ToolContext): Promise<DirectorDesignAsset> {
  if (ctx) assertDirectorToolActive(ctx)
  const draft = await getNewMediaRecord<DirectorDraft>('content-draft', draftId)
  if (!draft?.directorPlanId) throw new Error('该草稿不属于总监方案')
  const plan = await getDirectorPlan(draft.directorPlanId)
  if (plan.status !== 'confirmed' || !['xiaohongshu', 'wechat-official-account'].includes(plan.channel)) throw new Error('请先确认对应渠道方案')
  const handoffs = await listNewMediaRecords<{ draftId: string }>('xiaohongshu-handoff')
  if (handoffs.some(handoff => handoff.draftId === draftId)) throw new Error('草稿已准备交接；修改设计请新建草稿')
  const syncs = await listNewMediaRecords<{ draftId: string }>('wechat-director-sync')
  if (syncs.some(sync => sync.draftId === draftId)) throw new Error('草稿已开始同步；修改设计请新建草稿')
  validateDirectorSvg(svg)
  const png = plan.channel === 'wechat-official-account' ? await render(svg, { width: 900, height: 383 }) : await render(svg)
  if (ctx) assertDirectorToolActive(ctx)
  if (png.length > 10_000_000 || png.length < 8 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('设计渲染未返回有效 PNG')
  const id = randomUUID()
  const current = await getLatestDirectorDesign(draftId)
  if (ctx) assertDirectorToolActive(ctx)
  const asset: DirectorDesignAsset = { id, draftId, planId: plan.id, version: (current?.version ?? 0) + 1, pngSha256: sha256(png), svgSha256: sha256(Buffer.from(svg)), createdAt: Date.now() }
  mkdirSync(join(getNewMediaDir(), 'director-assets'), { recursive: true })
  let wrotePng = false
  let wroteSvg = false
  let recordWriteAttempted = false
  try {
    writeFileSync(assetPath(id, 'png'), png, { flag: 'wx', mode: 0o600 })
    wrotePng = true
    writeFileSync(assetPath(id, 'svg'), svg, { flag: 'wx', mode: 0o600 })
    wroteSvg = true
    if (ctx) assertDirectorToolActive(ctx)
    // SQLite 原子写可能在替换数据库后同步目录失败；此时记录是否落盘未知，必须保留素材。
    recordWriteAttempted = true
    return await putNewMediaRecord(ASSET_KIND, asset, ctx ? () => assertDirectorToolActive(ctx) : undefined)
  } catch (error) {
    if (!recordWriteAttempted && wrotePng) rmSync(assetPath(id, 'png'), { force: true })
    if (!recordWriteAttempted && wroteSvg) rmSync(assetPath(id, 'svg'), { force: true })
    throw error
  }
}

export async function getLatestDirectorDesign(draftId: string): Promise<DirectorDesignAsset | undefined> {
  return (await listNewMediaRecords<DirectorDesignAsset>(ASSET_KIND)).filter(asset => asset.draftId === draftId).sort((a, b) => (b.version ?? 0) - (a.version ?? 0) || b.createdAt - a.createdAt)[0]
}

export async function readDirectorDesign(assetId: string): Promise<{ asset: DirectorDesignAsset; png: Buffer; svg: Buffer }> {
  const asset = await getNewMediaRecord<DirectorDesignAsset>(ASSET_KIND, assetId)
  if (!asset) throw new Error('设计素材不存在')
  const png = readFileSync(assetPath(asset.id, 'png'))
  const svg = readFileSync(assetPath(asset.id, 'svg'))
  if (sha256(png) !== asset.pngSha256 || sha256(svg) !== asset.svgSha256) throw new Error('设计素材已变更或损坏，请重新制作')
  return { asset, png, svg }
}

export async function getDirectorDesignPreview(draftId: string): Promise<{ assetId: string; dataUrl: string } | null> {
  const asset = await getLatestDirectorDesign(draftId)
  if (!asset) return null
  const { png } = await readDirectorDesign(asset.id)
  return { assetId: asset.id, dataUrl: `data:image/png;base64,${png.toString('base64')}` }
}
