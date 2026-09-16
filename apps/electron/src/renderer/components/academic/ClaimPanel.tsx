/**
 * ClaimPanel - 主张与证据矩阵（M5.2，关闭 G5）
 *
 * 主张面板：创建主张、关联证据、按门禁确认状态。
 * 证据矩阵：按主张分组，**支持 / 反对 / 限定并排展示**——矛盾不被折叠，
 * 也不合成一个质量分数（方案 §6.3）。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { AlertTriangle, GitBranch, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  claimsAtom,
  claimsLoadingAtom,
  createClaimAtom,
  evidenceAtom,
  linkEvidenceAtom,
  loadClaimsAtom,
  preflightAtom,
  runObservationsAtom,
  setClaimStatusAtom,
} from '@/atoms/academic-atoms'
import type { ClaimStatus, ClaimType, EvidenceRelation, ResearchProject } from '@gravitas/shared'

const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
  empirical: '实证',
  methodological: '方法学',
  theoretical: '理论',
  limitation: '局限',
  'clinical-implication': '临床意义',
}

const STATUS_LABELS: Record<ClaimStatus, string> = {
  draft: '草稿',
  machine_checked: '机器已检查',
  needs_review: '待复核',
  researcher_verified: '研究者已确认',
  unsupported: '无证据支持',
  contested: '有争议',
  stale: '已失效',
}

const RELATION_LABELS: Record<EvidenceRelation, string> = {
  supports: '支持',
  opposes: '反对',
  qualifies: '限定',
}

export function ClaimPanel({ project }: { project: ResearchProject }): React.ReactElement {
  const claims = useAtomValue(claimsAtom)
  const loading = useAtomValue(claimsLoadingAtom)
  const preflight = useAtomValue(preflightAtom)
  const evidence = useAtomValue(evidenceAtom)
  const observations = useAtomValue(runObservationsAtom)
  const load = useSetAtom(loadClaimsAtom)
  const createClaim = useSetAtom(createClaimAtom)

  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState('')
  const [type, setType] = React.useState<ClaimType>('empirical')
  const [scope, setScope] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  React.useEffect(() => {
    void load(project.id)
  }, [project.id, load])

  return (
    <div className="mt-4 space-y-3 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-primary" />
          <span className="text-base font-semibold">主张与证据矩阵</span>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
          新增主张
        </Button>
      </div>

      {preflight && !preflight.ok && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            导出预检：{preflight.items.length} 条待处理
          </div>
          <div className="mt-1 space-y-0.5">
            {preflight.items.slice(0, 5).map((item) => (
              <div key={item.claimId} className="text-xs text-muted-foreground">
                「{item.text.slice(0, 40)}」— {item.issue}
              </div>
            ))}
          </div>
        </div>
      )}
      {preflight?.ok && claims.length > 0 && (
        <div className="text-xs text-muted-foreground">导出预检通过：全部主张均有支持证据且经研究者确认。</div>
      )}

      {message && <p className="text-xs text-muted-foreground">{message}</p>}

      {open && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="主张陈述（可被单独验证/推翻的一句话）" />
          <div className="flex gap-2">
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={type}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setType(e.target.value as ClaimType)}
            >
              {Object.entries(CLAIM_TYPE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            <Input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="适用范围（人群/条件/边界）" />
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || !text.trim()}
              onClick={async () => {
                setBusy(true)
                setMessage(null)
                try {
                  await createClaim({ projectId: project.id, input: { text, type, scope: scope || undefined } })
                  setText(''); setScope(''); setOpen(false)
                } catch (err) {
                  setMessage(err instanceof Error ? err.message : String(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              保存主张
            </Button>
          </div>
        </div>
      )}

      {claims.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          还没有主张。主张是可被单独验证的一句话；每条主张都应能追溯到具体证据。
        </div>
      ) : (
        claims.map((claim) => (
          <ClaimRow
            key={claim.id}
            claim={claim}
            projectId={project.id}
            evidenceOptions={evidence.map((e) => ({ id: e.id, text: e.text }))}
            observationOptions={observations.map((o) => ({ id: o.id, text: o.text }))}
            onMessage={setMessage}
          />
        ))
      )}
    </div>
  )
}

function ClaimRow({
  claim,
  projectId,
  evidenceOptions,
  observationOptions,
  onMessage,
}: {
  claim: ReturnType<typeof useAtomValue<typeof claimsAtom>>[number]
  projectId: string
  evidenceOptions: Array<{ id: string; text: string }>
  observationOptions: Array<{ id: string; text: string }>
  onMessage: (m: string | null) => void
}): React.ReactElement {
  const linkEvidence = useSetAtom(linkEvidenceAtom)
  const setStatus = useSetAtom(setClaimStatusAtom)
  const [linking, setLinking] = React.useState(false)
  const [relation, setRelation] = React.useState<EvidenceRelation>('supports')
  const [targetId, setTargetId] = React.useState('')
  const [targetKind, setTargetKind] = React.useState<'evidence' | 'observation'>('evidence')
  const [busy, setBusy] = React.useState(false)

  const contradicting = claim.summary.opposes > 0

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">{claim.text}</span>
            <Badge variant="outline">{CLAIM_TYPE_LABELS[claim.type]}</Badge>
            <Badge
              variant={
                claim.status === 'researcher_verified'
                  ? 'default'
                  : claim.status === 'stale' || contradicting
                    ? 'destructive'
                    : 'secondary'
              }
            >
              {STATUS_LABELS[claim.status]}
            </Badge>
          </div>
          {claim.scope && <div className="mt-1 text-xs text-muted-foreground">适用范围：{claim.scope}</div>}
          {claim.staleReason && <div className="mt-1 text-xs text-amber-600">{claim.staleReason}</div>}
          {claim.verification && (
            <div className="mt-1 text-xs text-muted-foreground">
              由 {claim.verification.verifiedBy.displayName} 确认
              {claim.verification.note ? ` · ${claim.verification.note}` : ''}
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={busy || claim.status === 'researcher_verified'}
            onClick={async () => {
              setBusy(true)
              onMessage(null)
              try {
                await setStatus({ projectId, claimId: claim.id, status: 'researcher_verified', note: '研究者确认' })
              } catch (err) {
                onMessage(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            确认
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => setLinking((v) => !v)}
          >
            关联证据
          </Button>
        </div>
      </div>

      {/* 证据矩阵：三列并排，矛盾不被折叠 */}
      <div className="grid grid-cols-3 gap-2">
        {(['supports', 'opposes', 'qualifies'] as const).map((rel) => {
          const items = claim.links.filter((l) => l.relation === rel)
          return (
            <div
              key={rel}
              className={`rounded border p-2 ${rel === 'opposes' && items.length > 0 ? 'border-destructive/50 bg-destructive/5' : ''}`}
            >
              <div className="mb-1 text-xs font-medium">
                {RELATION_LABELS[rel]}（{items.length}）
              </div>
              {items.length === 0 ? (
                <div className="text-[11px] text-muted-foreground">—</div>
              ) : (
                items.map((l) => {
                  const ref = l.evidenceId ?? l.observationId ?? l.runId ?? l.artifactId ?? ''
                  const known = l.evidenceId
                    ? evidenceOptions.find((e) => e.id === l.evidenceId)?.text
                    : l.observationId
                      ? observationOptions.find((o) => o.id === l.observationId)?.text
                      : ref
                  return (
                    <div key={l.id} className="text-[11px] text-muted-foreground">
                      {known?.slice(0, 60) ?? ref}
                      {l.note ? ` · ${l.note}` : ''}
                    </div>
                  )
                })
              )}
            </div>
          )
        })}
      </div>

      {linking && (
        <div className="space-y-2 rounded border bg-muted/30 p-2">
          <div className="flex gap-2">
            <select
              className="rounded-md border bg-background px-2 py-1 text-xs"
              value={relation}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setRelation(e.target.value as EvidenceRelation)}
            >
              {Object.entries(RELATION_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            <select
              className="rounded-md border bg-background px-2 py-1 text-xs"
              value={targetKind}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                setTargetKind(e.target.value as 'evidence' | 'observation')
                setTargetId('')
              }}
            >
              <option value="evidence">证据片段</option>
              <option value="observation">观察记录</option>
            </select>
          </div>
          <select
            className="w-full rounded-md border bg-background px-2 py-1 text-xs"
            value={targetId}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTargetId(e.target.value)}
          >
            <option value="">选择…</option>
            {(targetKind === 'evidence' ? evidenceOptions : observationOptions).map((o) => (
              <option key={o.id} value={o.id}>{o.text.slice(0, 70)}</option>
            ))}
          </select>
          <div className="flex justify-end">
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={busy || !targetId}
              onClick={async () => {
                setBusy(true)
                onMessage(null)
                try {
                  await linkEvidence({
                    projectId,
                    input: {
                      claimId: claim.id,
                      relation,
                      ...(targetKind === 'evidence' ? { evidenceId: targetId } : { observationId: targetId }),
                    },
                  })
                  setTargetId('')
                  setLinking(false)
                } catch (err) {
                  onMessage(err instanceof Error ? err.message : String(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              关联
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
