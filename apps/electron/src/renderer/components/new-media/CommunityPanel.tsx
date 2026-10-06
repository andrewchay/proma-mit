import * as React from 'react'
import type { NewMediaEngagementItem, NewMediaPlatform } from '@gravitas/shared'

export function CommunityPanel({ items, onRefresh }: { items: NewMediaEngagementItem[]; onRefresh: () => Promise<void> }): React.ReactElement {
  const [author, setAuthor] = React.useState('')
  const [text, setText] = React.useState('')
  const [platform, setPlatform] = React.useState<NewMediaPlatform>('xiaohongshu')
  const add = async (): Promise<void> => {
    if (!author.trim() || !text.trim()) return
    await window.electronAPI.paa.newMedia.community.ingestEngagement({ platform, channel: 'comment', author, text })
    setAuthor(''); setText(''); await onRefresh()
  }
  const draftReply = async (id: string): Promise<void> => { await window.electronAPI.paa.newMedia.community.createReplyDraft(id); await onRefresh() }
  return <div className="mx-auto max-w-5xl space-y-4">
    <section className="rounded-2xl bg-background p-4 shadow-sm"><h2 className="mb-3 font-medium">录入互动样本</h2><div className="grid gap-2 md:grid-cols-[160px_180px_1fr_auto]"><select value={platform} onChange={(e) => setPlatform(e.target.value as NewMediaPlatform)} className="rounded-lg bg-muted px-3 py-2 text-sm"><option value="xiaohongshu">小红书</option><option value="wechat-official-account">公众号</option></select><input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="作者" className="rounded-lg bg-muted px-3 py-2 text-sm"/><input value={text} onChange={(e) => setText(e.target.value)} placeholder="评论或私信内容" className="rounded-lg bg-muted px-3 py-2 text-sm"/><button onClick={() => void add()} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">分流</button></div></section>
    <section className="space-y-3">{items.map((item) => <article key={item.id} className="rounded-2xl bg-background p-4 shadow-sm"><div className="flex items-center gap-2"><strong>{item.author}</strong><span className="rounded-full bg-muted px-2 py-0.5 text-xs">{item.intent}</span><span className="rounded-full bg-muted px-2 py-0.5 text-xs">{item.priority}</span>{item.requiresHumanReview && <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-600">需人工处理</span>}</div><p className="mt-2 text-sm">{item.text}</p>{!item.requiresHumanReview && <div className="mt-3 text-right"><button onClick={() => void draftReply(item.id)} className="text-xs text-primary hover:underline">生成回复草稿</button></div>}</article>)}</section>
  </div>
}
