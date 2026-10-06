import * as React from 'react'
import type { NewMediaListeningQuery, NewMediaMention } from '@gravitas/shared'

export function ListeningPanel({ queries, mentions, onRefresh }: { queries: NewMediaListeningQuery[]; mentions: NewMediaMention[]; onRefresh: () => Promise<void> }): React.ReactElement {
  const [keywords, setKeywords] = React.useState('')
  const [queryId, setQueryId] = React.useState('')
  const [text, setText] = React.useState('')
  React.useEffect(() => { if (!queryId && queries[0]) setQueryId(queries[0].id) }, [queries, queryId])
  const create = async (): Promise<void> => { const values = keywords.split(/[,，\n]/).map(v => v.trim()).filter(Boolean); if (!values.length) return; await window.electronAPI.paa.newMedia.listening.createQuery(values); setKeywords(''); await onRefresh() }
  const addMention = async (): Promise<void> => { if (!queryId || !text.trim()) return; await window.electronAPI.paa.newMedia.listening.ingestMention({ queryId, platform: 'xiaohongshu', sourceUrl: 'local://manual-entry', text }); setText(''); await onRefresh() }
  return <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[360px_1fr]">
    <div className="space-y-4"><section className="rounded-2xl bg-background p-4 shadow-sm"><h2 className="mb-3 font-medium">新建监听任务</h2><textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="品牌词、产品词，用逗号分隔" className="min-h-20 w-full rounded-xl bg-muted p-3 text-sm"/><button onClick={() => void create()} className="mt-2 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">创建任务</button></section><section className="rounded-2xl bg-background p-4 shadow-sm"><h2 className="mb-2 font-medium">监听任务</h2>{queries.map(q => <button key={q.id} onClick={() => setQueryId(q.id)} className={`mb-2 w-full rounded-lg p-3 text-left text-sm ${queryId === q.id ? 'bg-primary/10 text-primary' : 'bg-muted/50'}`}>{q.keywords.join(' · ')}</button>)}</section></div>
    <div className="space-y-4"><section className="rounded-2xl bg-background p-4 shadow-sm"><h2 className="mb-3 font-medium">手工录入提及</h2><div className="flex gap-2"><input value={text} onChange={(e) => setText(e.target.value)} placeholder="提及文本（本阶段不自动抓取平台）" className="flex-1 rounded-lg bg-muted px-3 py-2 text-sm"/><button onClick={() => void addMention()} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">分析</button></div></section><section className="space-y-3">{mentions.filter(m => !queryId || m.queryId === queryId).map(m => <article key={m.id} className="rounded-2xl bg-background p-4 shadow-sm"><div className="flex justify-between"><span className="text-xs text-foreground/50">{new Date(m.createdAt).toLocaleString()}</span><span className={`rounded-full px-2 py-0.5 text-xs ${m.risk === 'high' ? 'bg-red-500/10 text-red-600' : 'bg-muted'}`}>{m.risk}</span></div><p className="mt-2 text-sm">{m.text}</p></article>)}</section></div>
  </div>
}
