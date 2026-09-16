/**
 * SourceLibraryPanel - 项目内文献库面板（M2 第二批）
 *
 * 四个区块：跨库检索 + 导入、来源列表（含筛选按钮）、去重复核、
 * 证据台账。刻意做成单文件三段式布局，避免为 MVP 过度拆分。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  extractEvidenceAtom,
  importBibliographyAtom,
  loadSourceLibraryAtom,
  recordScreeningAtom,
  researchDedupCandidatesAtom,
  researchEvidenceAtom,
  researchScreeningAtom,
  researchSearchRunsAtom,
  researchSourcesAtom,
  searchExternalSourcesAtom,
  sourceLibraryLoadingAtom,
} from '@/atoms/academic-atoms'
import type { EvidenceLocator, ScreeningDecision, Source } from '@gravitas/shared'
import type { ResearchProject } from '@gravitas/shared'

export function SourceLibraryPanel({ project }: { project: ResearchProject }): React.ReactElement {
  const loading = useAtomValue(sourceLibraryLoadingAtom)
  const loadLibrary = useSetAtom(loadSourceLibraryAtom)

  React.useEffect(() => {
    void loadLibrary(project.id)
  }, [project.id, loadLibrary])

  return (
    <div className="mt-4 space-y-4 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
      <div className="text-base font-semibold">文献库</div>
      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          加载文献…
        </div>
      ) : (
        <>
          <SearchSection project={project} />
          <SourceListSection project={project} />
          <DedupSection />
          <EvidenceSection project={project} />
        </>
      )}
    </div>
  )
}

// ===== 检索与导入 =====

function SearchSection({ project }: { project: ResearchProject }): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const [databases, setDatabases] = React.useState<string[]>(['openalex'])
  const [running, setRunning] = React.useState(false)
  const [importOpen, setImportOpen] = React.useState(false)
  const search = useSetAtom(searchExternalSourcesAtom)
  const runs = useAtomValue(researchSearchRunsAtom)
  const lastRun = runs[0]

  const toggleDb = (db: string) => {
    setDatabases((prev) => (prev.includes(db) ? prev.filter((d) => d !== db) : [...prev, db]))
  }

  return (
    <div className="space-y-2 rounded-md border p-4">
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="检索词（OpenAlex / arXiv，公开 API）"
          onKeyDown={async (e) => {
            if (e.key === 'Enter' && query.trim() && databases.length > 0) {
              setRunning(true)
              try {
                await search({ projectId: project.id, query, databases, limit: 20 })
              } finally {
                setRunning(false)
              }
            }
          }}
        />
        <Button
          size="sm"
          disabled={running || !query.trim() || databases.length === 0}
          onClick={async () => {
            setRunning(true)
            try {
              await search({ projectId: project.id, query, databases, limit: 20 })
            } finally {
              setRunning(false)
            }
          }}
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          检索
        </Button>
        <Button size="sm" variant="outline" onClick={() => setImportOpen((v) => !v)}>
          导入 RIS/BibTeX
        </Button>
      </div>

      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        {['openalex', 'arxiv'].map((db) => (
          <label key={db} className="flex items-center gap-1">
            <input type="checkbox" checked={databases.includes(db)} onChange={() => toggleDb(db)} />
            {db}
          </label>
        ))}
      </div>

      {lastRun && (
        <div className="text-xs text-muted-foreground">
          最近检索「{lastRun.query}」：{lastRun.resultCount} 条结果（{lastRun.databases.join(' / ')}）
          {lastRun.truncated && ' · 结果已截断'}
          {lastRun.errors.length > 0 && ` · 错误: ${lastRun.errors.join('; ')}`}
        </div>
      )}

      {importOpen && <ImportSection project={project} onDone={() => setImportOpen(false)} />}
    </div>
  )
}

function ImportSection({ project, onDone }: { project: ResearchProject; onDone: () => void }): React.ReactElement {
  const [format, setFormat] = React.useState<'ris' | 'bibtex'>('ris')
  const [text, setText] = React.useState('')
  const [errorText, setErrorText] = React.useState<string | null>(null)
  const importBib = useSetAtom(importBibliographyAtom)

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="flex gap-2 text-sm">
        {(['ris', 'bibtex'] as const).map((f) => (
          <label key={f} className="flex items-center gap-1">
            <input type="radio" checked={format === f} onChange={() => setFormat(f)} />
            {f.toUpperCase()}
          </label>
        ))}
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="粘贴从 Zotero / 数据库导出的 RIS 或 BibTeX 文本"
      />
      {errorText && <p className="text-xs text-destructive">{errorText}</p>}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          disabled={!text.trim()}
          onClick={async () => {
            setErrorText(null)
            try {
              await importBib({ projectId: project.id, format, text })
              setText('')
              onDone()
            } catch (err) {
              setErrorText(err instanceof Error ? err.message : String(err))
            }
          }}
        >
          导入
        </Button>
      </div>
    </div>
  )
}

// ===== 来源列表与筛选 =====

function screeningStateFor(
  sourceId: string,
  decisions: ScreeningDecision[],
): ScreeningDecision['decision'] | null {
  const mine = decisions.filter((d) => d.sourceId === sourceId && d.round === 'title-abstract')
  return mine.length > 0 ? mine[mine.length - 1]!.decision : null
}

function SourceListSection({ project }: { project: ResearchProject }): React.ReactElement {
  const sources = useAtomValue(researchSourcesAtom)
  const screening = useAtomValue(researchScreeningAtom)
  const recordScreening = useSetAtom(recordScreeningAtom)

  if (sources.length === 0) {
    return <div className="text-sm text-muted-foreground">还没有来源：先检索或导入文献。</div>
  }

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">来源（{sources.length}）</div>
      {sources.map((source) => {
        const version = source.versions[0]!
        const state = screeningStateFor(source.id, screening)
        return (
          <div key={source.id} className="rounded-md border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{version.title}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {version.authors.length > 0 && <span>{version.authors.slice(0, 3).join(', ')}{version.authors.length > 3 ? ' 等' : ''}</span>}
                  {version.year && <span>· {version.year}</span>}
                  {version.venue && <span>· {version.venue}</span>}
                  <Badge variant="outline" className="text-[10px]">{version.retrievalStatus}</Badge>
                  {version.externalIds.map((id) => (
                    <span key={`${id.namespace}:${id.value}`} className="text-[10px]">
                      {id.namespace}:{id.value}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                {(['include', 'exclude'] as const).map((decision) => (
                  <Button
                    key={decision}
                    size="sm"
                    variant={state === decision ? (decision === 'include' ? 'default' : 'destructive') : 'outline'}
                    className="h-7 px-2 text-xs"
                    onClick={async () => {
                      await recordScreening({
                        projectId: project.id,
                        sourceId: source.id,
                        round: 'title-abstract',
                        decision,
                        reason: decision === 'include' ? '初筛纳入' : '初筛排除',
                      })
                    }}
                  >
                    {decision === 'include' ? '纳入' : '排除'}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ===== 去重复核 =====

function DedupSection(): React.ReactElement {
  const candidates = useAtomValue(researchDedupCandidatesAtom)
  if (candidates.length === 0) return <div />

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="mb-1 text-sm font-medium">去重复核（{candidates.length}）</div>
      {candidates.map((c, i) => (
        <div key={i} className="text-xs text-muted-foreground">
          {c.kind === 'exact-id' ? '同一标识' : '标题相似（需人工）'}：{c.detail}
        </div>
      ))}
      <div className="mt-1 text-xs text-muted-foreground">合并将在后续版本提供；先人工核对。</div>
    </div>
  )
}

// ===== 证据台账 =====

function EvidenceSection({ project }: { project: ResearchProject }): React.ReactElement {
  const evidence = useAtomValue(researchEvidenceAtom)
  const sources = useAtomValue(researchSourcesAtom)
  const extract = useSetAtom(extractEvidenceAtom)
  const [open, setOpen] = React.useState(false)
  const [targetSource, setTargetSource] = React.useState<Source | null>(null)
  const [text, setText] = React.useState('')
  const [page, setPage] = React.useState('1')
  const [note, setNote] = React.useState('')
  const [errorText, setErrorText] = React.useState<string | null>(null)

  const includedSources = sources.filter((s) => s.versions[0]?.retrievalStatus !== undefined)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">证据台账（{evidence.length}）</div>
        <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)} disabled={includedSources.length === 0}>
          抽取证据
        </Button>
      </div>

      {open && targetSource === null && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <div className="text-xs text-muted-foreground">选择来源：</div>
          {includedSources.map((s) => (
            <button
              key={s.id}
              className="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-muted"
              onClick={() => setTargetSource(s)}
            >
              {s.versions[0]!.title}
            </button>
          ))}
        </div>
      )}

      {open && targetSource && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <div className="text-xs text-muted-foreground">来源：{targetSource.versions[0]!.title}</div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="原文片段（逐字摘录；模型生成的摘要不是证据）"
          />
          <div className="flex gap-2">
            <Input value={page} onChange={(e) => setPage(e.target.value)} placeholder="页码" className="w-24" />
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（为什么重要）" />
          </div>
          {errorText && <p className="text-xs text-destructive">{errorText}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setTargetSource(null); setOpen(false) }}>取消</Button>
            <Button
              size="sm"
              disabled={!text.trim()}
              onClick={async () => {
                setErrorText(null)
                const pageNum = parseInt(page, 10)
                const locator: EvidenceLocator =
                  Number.isInteger(pageNum) && pageNum > 0
                    ? { kind: 'page', page: pageNum }
                    : { kind: 'section', label: page.trim() || '未标注' }
                try {
                  await extract({
                    projectId: project.id,
                    sourceId: targetSource.id,
                    sourceVersionId: targetSource.versions[0]!.id,
                    text,
                    locator,
                    note: note.trim() || undefined,
                  })
                  setText(''); setNote(''); setTargetSource(null); setOpen(false)
                } catch (err) {
                  setErrorText(err instanceof Error ? err.message : String(err))
                }
              }}
            >
              保存证据
            </Button>
          </div>
        </div>
      )}

      {evidence.map((e) => (
        <div key={e.id} className="rounded-md border p-3 text-sm">
          <div className="truncate text-muted-foreground">「{e.text}」</div>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="text-[10px]">
              {e.extractionMode === 'agent-suggested' ? '待确认' : '已确认'}
            </Badge>
            <span>{locatorLabel(e.locator)}</span>
            {e.note && <span>· {e.note}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

function locatorLabel(locator: EvidenceLocator): string {
  switch (locator.kind) {
    case 'pdf-page':
      return `PDF 第 ${locator.page} 页`
    case 'page':
      return `第 ${locator.page} 页`
    case 'section':
      return `章节「${locator.label}」`
    case 'timestamp':
      return `${locator.startSeconds}s`
    case 'url':
      return locator.url
    case 'table':
      return `表格 ${locator.tableId}`
  }
}
