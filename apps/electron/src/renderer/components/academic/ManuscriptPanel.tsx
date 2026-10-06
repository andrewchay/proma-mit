/**
 * ManuscriptPanel - 稿件编辑器（M5.2）
 *
 * 章节编辑 + 逐节关联主张 + 版本化（新版需变更理由）。
 * 引用主张时显示主张当前状态：**引用已失效/有争议的主张会被明确标出**，
 * 避免「稿件看起来完整但依据已动摇」（方案 §6.3 失效传播）。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FileText, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { claimsAtom, createManuscriptAtom, manuscriptsAtom } from '@/atoms/academic-atoms'
import type { ResearchProject } from '@gravitas/shared'

interface DraftSection {
  heading: string
  content: string
  claimIds: string[]
}

export function ManuscriptPanel({ project }: { project: ResearchProject }): React.ReactElement {
  const manuscripts = useAtomValue(manuscriptsAtom)
  const claims = useAtomValue(claimsAtom)
  const createManuscript = useSetAtom(createManuscriptAtom)

  const latest = manuscripts.length > 0 ? manuscripts[manuscripts.length - 1]! : null
  const [title, setTitle] = React.useState('')
  const [sections, setSections] = React.useState<DraftSection[]>([{ heading: '引言', content: '', claimIds: [] }])
  const [changeReason, setChangeReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState(false)

  const claimById = new Map(claims.map((c) => [c.id, c]))

  const loadLatestIntoDraft = () => {
    if (!latest) return
    setTitle(latest.title)
    setSections(
      latest.sections.map((s) => ({ heading: s.heading, content: s.content, claimIds: [...s.claimIds] })),
    )
  }

  return (
    <div className="mt-4 space-y-3 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" />
          <span className="text-base font-semibold">稿件</span>
          {latest && <Badge variant="outline">v{latest.version}</Badge>}
        </div>
        <div className="flex gap-2">
          {latest && (
            <Button size="sm" variant="ghost" onClick={loadLatestIntoDraft}>
              载入当前版本
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
            {open ? '收起' : latest ? '新建版本' : '创建稿件'}
          </Button>
        </div>
      </div>

      {latest && !open && (
        <div className="space-y-2">
          <div className="text-sm font-medium">{latest.title}</div>
          {latest.sections.map((s) => (
            <div key={s.id} className="rounded border p-2">
              <div className="text-xs font-medium">{s.heading}</div>
              <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                {s.content || '（空）'}
              </div>
              {s.claimIds.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {s.claimIds.map((id) => {
                    const c = claimById.get(id)
                    const risky = c && (c.status === 'stale' || c.summary.opposes > 0)
                    return (
                      <Badge key={id} variant={risky ? 'destructive' : 'secondary'} className="text-[10px]">
                        {risky ? '⚠ ' : ''}
                        {c?.text.slice(0, 20) ?? id}
                      </Badge>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
          {latest.changeReason && (
            <div className="text-xs text-muted-foreground">变更理由：{latest.changeReason}</div>
          )}
        </div>
      )}

      {message && <p className="text-xs text-muted-foreground">{message}</p>}

      {open && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="稿件标题" />

          {sections.map((section, idx) => (
            <div key={idx} className="space-y-1 rounded border bg-background p-2">
              <div className="flex gap-2">
                <Input
                  value={section.heading}
                  onChange={(e) =>
                    setSections((prev) => prev.map((s, i) => (i === idx ? { ...s, heading: e.target.value } : s)))
                  }
                  placeholder="章节标题"
                  className="h-8 text-xs"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-xs"
                  onClick={() => setSections((prev) => prev.filter((_, i) => i !== idx))}
                  disabled={sections.length === 1}
                >
                  删除
                </Button>
              </div>
              <Textarea
                rows={3}
                value={section.content}
                onChange={(e) =>
                  setSections((prev) => prev.map((s, i) => (i === idx ? { ...s, content: e.target.value } : s)))
                }
                placeholder="章节内容"
              />
              {claims.length > 0 && (
                <div className="space-y-0.5">
                  <div className="text-[11px] text-muted-foreground">关联主张（可疑主张会被标出）</div>
                  {claims.slice(0, 8).map((c) => {
                    const risky = c.status === 'stale' || c.summary.opposes > 0
                    return (
                      <label key={c.id} className="flex items-start gap-2 text-[11px]">
                        <input
                          type="checkbox"
                          checked={section.claimIds.includes(c.id)}
                          onChange={() =>
                            setSections((prev) =>
                              prev.map((s, i) =>
                                i === idx
                                  ? {
                                      ...s,
                                      claimIds: s.claimIds.includes(c.id)
                                        ? s.claimIds.filter((x) => x !== c.id)
                                        : [...s.claimIds, c.id],
                                    }
                                  : s,
                              ),
                            )
                          }
                        />
                        <span className={risky ? 'text-destructive' : 'text-muted-foreground'}>
                          {risky ? '⚠ ' : ''}
                          {c.text.slice(0, 50)}
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          ))}

          <Button
            size="sm"
            variant="secondary"
            onClick={() => setSections((prev) => [...prev, { heading: '', content: '', claimIds: [] }])}
          >
            添加章节
          </Button>

          {latest && (
            <Input
              value={changeReason}
              onChange={(e) => setChangeReason(e.target.value)}
              placeholder="变更理由（新建版本必填）"
            />
          )}

          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || !title.trim() || (latest !== null && !changeReason.trim())}
              onClick={async () => {
                setBusy(true)
                setMessage(null)
                try {
                  const manuscript = await createManuscript({
                    projectId: project.id,
                    draft: {
                      title,
                      sections: sections.filter((s) => s.heading.trim()),
                      changeReason: changeReason || undefined,
                    },
                  })
                  setMessage(`已保存 v${manuscript.version}`)
                  setChangeReason('')
                  setOpen(false)
                } catch (err) {
                  setMessage(err instanceof Error ? err.message : String(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              保存为新版本
            </Button>
          </div>
        </div>
      )}

      {manuscripts.length > 1 && (
        <div className="text-xs text-muted-foreground">
          历史版本：{manuscripts.map((m) => `v${m.version}`).join(' · ')}
        </div>
      )}
    </div>
  )
}
