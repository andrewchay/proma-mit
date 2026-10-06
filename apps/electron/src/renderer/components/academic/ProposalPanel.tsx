/**
 * ProposalPanel - 选题候选面板（M3.2）
 *
 * 展示候选的 gap 类型、支持/反证证据数、查新范围与记录缺口；
 * 选定与否决是人的动作（actor 由主进程确定）。
 * 刻意不显示任何「新颖性总分」——方案 §5/§13.3 明确不承诺统一自动评分。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Lightbulb, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  createTopicAtom,
  evidenceAtom,
  loadTopicsAtom,
  rejectTopicAtom,
  selectTopicAtom,
  topicsAtom,
} from '@/atoms/academic-atoms'
import type { ResearchGapType, ResearchProject } from '@gravitas/shared'

const GAP_LABELS: Record<ResearchGapType, string> = {
  'unstudied-population': '未研究人群',
  'unstudied-comparison': '未研究比较',
  methodological: '方法学空白',
  'contradictory-evidence': '证据矛盾',
  'context-transfer': '情境迁移',
  conceptual: '概念澄清',
}

const STATUS_LABELS: Record<string, string> = {
  candidate: '候选',
  selected: '已选定',
  rejected: '已否决',
}

export function ProposalPanel({ project }: { project: ResearchProject }): React.ReactElement {
  const topics = useAtomValue(topicsAtom)
  const evidence = useAtomValue(evidenceAtom)
  const load = useSetAtom(loadTopicsAtom)
  const create = useSetAtom(createTopicAtom)
  const select = useSetAtom(selectTopicAtom)
  const reject = useSetAtom(rejectTopicAtom)

  const [open, setOpen] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [question, setQuestion] = React.useState('')
  const [gapType, setGapType] = React.useState<ResearchGapType>('unstudied-comparison')
  const [gapRationale, setGapRationale] = React.useState('')
  const [counterarguments, setCounterarguments] = React.useState('')
  const [queries, setQueries] = React.useState('')
  const [databases, setDatabases] = React.useState('openalex')
  const [closestSourceIds, setClosestSourceIds] = React.useState('')
  const [limitations, setLimitations] = React.useState('')
  const [supportingIds, setSupportingIds] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  React.useEffect(() => {
    void load(project.id)
  }, [project.id, load])

  return (
    <div className="mt-4 space-y-3 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-primary" />
          <span className="text-base font-semibold">选题候选</span>
          <span className="text-xs text-muted-foreground">不提供新颖性总分；由研究者判断可研究性</span>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
          新增候选
        </Button>
      </div>

      {message && <p className="text-xs text-muted-foreground">{message}</p>}

      {open && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="选题标题" />
          <Textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} placeholder="研究问题" />
          <select
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={gapType}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setGapType(e.target.value as ResearchGapType)}
          >
            {Object.entries(GAP_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <Textarea value={gapRationale} onChange={(e) => setGapRationale(e.target.value)} rows={2} placeholder="gap 论证：既有工作为什么不能解决" />
          <Input value={queries} onChange={(e) => setQueries(e.target.value)} placeholder="查新检索词（逗号分隔）" />
          <Input value={databases} onChange={(e) => setDatabases(e.target.value)} placeholder="查新数据库（逗号分隔）" />
          <Input value={closestSourceIds} onChange={(e) => setClosestSourceIds(e.target.value)} placeholder="最接近的既有工作（来源 id，逗号分隔）" />
          <Input value={limitations} onChange={(e) => setLimitations(e.target.value)} placeholder="检索局限（逗号分隔，如：未覆盖非英文文献）" />
          <Textarea value={counterarguments} onChange={(e) => setCounterarguments(e.target.value)} rows={2} placeholder="反例/替代解释（每行一条）" />

          {evidence.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">关联支持证据（台账片段）</div>
              {evidence.slice(0, 8).map((ev) => (
                <label key={ev.id} className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={supportingIds.includes(ev.id)}
                    onChange={() =>
                      setSupportingIds((prev) =>
                        prev.includes(ev.id) ? prev.filter((x) => x !== ev.id) : [...prev, ev.id],
                      )
                    }
                  />
                  <span className="truncate text-muted-foreground">{ev.text.slice(0, 60)}</span>
                </label>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>取消</Button>
            <Button
              size="sm"
              disabled={busy || !title.trim() || !question.trim() || !gapRationale.trim()}
              onClick={async () => {
                setBusy(true)
                setMessage(null)
                try {
                  await create({
                    projectId: project.id,
                    draft: {
                      title,
                      question,
                      gapType,
                      gapRationale,
                      supportingEvidenceIds: supportingIds,
                      contradictingEvidenceIds: [],
                      counterarguments: splitList(counterarguments),
                      noveltyCheck: {
                        queries: splitList(queries),
                        databases: splitList(databases),
                        checkedAt: new Date().toISOString(),
                        closestSourceIds: splitList(closestSourceIds),
                        limitations: splitList(limitations),
                      },
                    },
                  })
                  setOpen(false)
                  setTitle(''); setQuestion(''); setGapRationale(''); setSupportingIds([])
                  setMessage('已保存候选')
                } catch (err) {
                  setMessage(err instanceof Error ? err.message : String(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              保存候选
            </Button>
          </div>
        </div>
      )}

      {topics.length === 0 ? (
        <div className="text-sm text-muted-foreground">还没有选题候选。</div>
      ) : (
        topics.map((t) => (
          <div key={t.id} className="rounded-md border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{t.title}</span>
                  <Badge variant="outline">{GAP_LABELS[t.gapType]}</Badge>
                  <Badge variant={t.status === 'selected' ? 'default' : 'secondary'}>
                    {STATUS_LABELS[t.status]}
                  </Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{t.question}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  支持证据 {t.supportingEvidenceIds.length} · 反证 {t.contradictingEvidenceIds.length} · 查新最接近工作{' '}
                  {t.noveltyCheck.closestSourceIds.length}
                </div>
                {t.recordednessGaps.length > 0 && t.status === 'candidate' && (
                  <div className="mt-1 text-xs text-amber-600">
                    记录缺口：{t.recordednessGaps.join('；')}
                  </div>
                )}
              </div>
              {t.status === 'candidate' && (
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      setMessage(null)
                      try {
                        await select({ projectId: project.id, proposalId: t.id, force: t.recordednessGaps.length > 0 })
                        setMessage(`已选定「${t.title}」`)
                      } catch (err) {
                        setMessage(err instanceof Error ? err.message : String(err))
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    选定
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      setMessage(null)
                      try {
                        await reject({ projectId: project.id, proposalId: t.id, reason: '与既有工作重复或被判定不可行' })
                      } catch (err) {
                        setMessage(err instanceof Error ? err.message : String(err))
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    否决
                  </Button>
                </div>
              )}
            </div>
            {t.selection && (
              <div className="mt-1 text-xs text-muted-foreground">
                由 {t.selection.selectedBy.displayName} 选定
                {t.selection.reason ? ` · ${t.selection.reason}` : ''}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}

function splitList(raw: string): string[] {
  return raw.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
}
