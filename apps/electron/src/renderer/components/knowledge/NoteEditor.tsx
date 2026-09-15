/**
 * NoteEditor — 笔记编辑态
 *
 * 与 NoteDetail（只读）并列：同一块区域在编辑开关下渲染其中之一。
 * 写操作会修改用户磁盘上的 Markdown，因此这里做三件事：
 *
 * 1. **权益门禁前置**：无 knowledge-pro 时不显示编辑入口，而不是让用户
 *    点进去再失败。门禁由主进程 hasCapability 判定（唯一权威）。
 * 2. **未保存变更拦截**：切换笔记、关闭编辑器、删除前都检查 dirty 状态。
 * 3. **外部变更检测**：保存前比对文件 mtime，避免覆盖用户在 Obsidian
 *    里的修改。
 */
import * as React from 'react'
import { AlertTriangle, Check, Loader2, Save, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { KnowledgeNote } from '@gravitas/shared'

interface NoteEditorProps {
  note: KnowledgeNote
  vaultId: string
  /** 保存成功后回调（用于刷新索引） */
  onSaved: (title: string) => void | Promise<void>
  onCancel: () => void
}

/**
 * 从笔记的 content 中剥离一级标题行。
 *
 * parseNote 的 content 包含标题，而编辑区只承载正文 —— 标题由单独的
 * 输入框维护。不剥离会让每次保存都多出一行标题。
 */
function stripHeading(content: string, title: string): string {
  const trimmed = content.trimStart()
  const match = trimmed.match(/^#\s+(.+)\r?\n?/)
  if (match && match[1]?.trim() === title.trim()) {
    return trimmed.slice(match[0].length)
  }
  return content
}

/** frontmatter 转可编辑文本（每行 key: value） */
function frontmatterToText(fm: Record<string, unknown>): string {
  return Object.entries(fm)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join('\n')
}

/** 编辑文本转 frontmatter */
function textToFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const raw = line.slice(idx + 1).trim()
    if (!key) continue
    // 逗号分隔视为数组，与 generateNoteContent 的序列化保持一致
    result[key] = raw.includes(',') ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw
  }
  return result
}

export function NoteEditor({
  note,
  vaultId,
  onSaved,
  onCancel,
}: NoteEditorProps): React.ReactElement {
  const api = window.electronAPI?.knowledge

  const [title, setTitle] = React.useState(note.title)
  const [body, setBody] = React.useState(() => stripHeading(note.content, note.title))
  const [frontmatterText, setFrontmatterText] = React.useState(() =>
    frontmatterToText(note.frontmatter ?? {}),
  )
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [showFrontmatter, setShowFrontmatter] = React.useState(
    Object.keys(note.frontmatter ?? {}).length > 0,
  )
  /**
   * 加载时的内容版本（主进程哈希）。
   *
   * 保存时回传给主进程比对，是并发编辑的唯一防线：渲染层提示可以被
   * 任何其他调用方绕过，且 mtime 无法区分同秒内的两次写入。
   */
  const [loadedVersion, setLoadedVersion] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!api || !note.vaultId) return
    void api
      .noteFileVersion(note.vaultId, note.filePath)
      .then((version) => setLoadedVersion(version))
      .catch(() => setLoadedVersion(null))
  }, [api, note.vaultId, note.filePath])

  const dirty =
    title !== note.title ||
    body !== stripHeading(note.content, note.title) ||
    frontmatterText !== frontmatterToText(note.frontmatter ?? {})

  /** 保存：主进程按内容版本判定并发冲突 */
  const handleSave = async (): Promise<void> => {
    if (!api) return
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      setError('标题不能为空')
      return
    }

    setSaving(true)
    setError(null)
    try {
      // 先查是否已被外部改动，让用户决定是否覆盖；主进程仍会复核一次
      let force = false
      if (loadedVersion) {
        const current = await api.noteFileVersion(note.vaultId, note.filePath)
        if (current && current !== loadedVersion) {
          force = window.confirm(
            '这篇笔记在磁盘上已被其他程序修改（可能是 Obsidian）。\n\n继续保存会覆盖那些修改。确定继续？',
          )
          if (!force) {
            setSaving(false)
            return
          }
        }
      }

      // 标题变了走重命名（同时改文件名与一级标题），否则只更新内容
      if (trimmedTitle !== note.title) {
        await api.renameNote({
          vaultId: note.vaultId,
          relativePath: note.filePath,
          newTitle: trimmedTitle,
          expectedVersion: loadedVersion ?? undefined,
          force,
        })
      }
      await api.updateNote({
        vaultId: note.vaultId,
        relativePath: note.filePath,
        content: body,
        frontmatter: textToFrontmatter(frontmatterText),
        expectedVersion: loadedVersion ?? undefined,
        force,
      })
      await onSaved(trimmedTitle)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  /** 取消：有未保存变更时确认 */
  const handleCancel = (): void => {
    if (dirty && !window.confirm('有未保存的修改，确定放弃？')) return
    onCancel()
  }

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 px-5 py-2.5 border-b border-border/50 flex-shrink-0">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="笔记标题"
          className="h-8 text-[14px] font-medium flex-1 max-w-md"
        />
        {dirty && <span className="text-[11px] text-amber-600">未保存</span>}
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={handleCancel} disabled={saving}>
          <X size={14} />
          取消
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          保存
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
        {/* Properties 编辑 */}
        <div>
          <button
            onClick={() => setShowFrontmatter((v) => !v)}
            className="text-[11px] font-medium text-foreground/45 hover:text-foreground/70"
          >
            {showFrontmatter ? '▾' : '▸'} Properties
          </button>
          {showFrontmatter && (
            <textarea
              value={frontmatterText}
              onChange={(e) => setFrontmatterText(e.target.value)}
              placeholder={'每行一个属性，如：\ntags: 项目, 紧急\nauthor: 我'}
              spellCheck={false}
              className="mt-1.5 w-full h-20 px-2.5 py-2 rounded-md border border-input bg-transparent text-[12px] font-mono leading-relaxed resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          )}
        </div>

        {/* 正文编辑 */}
        <div className="flex-1">
          <div className="text-[11px] font-medium text-foreground/45 mb-1.5">正文</div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="使用 Markdown 编写，支持 [[双向链接]] 与 #标签"
            spellCheck={false}
            className="w-full min-h-[400px] px-3 py-2.5 rounded-md border border-input bg-transparent text-[13px] leading-relaxed resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-[12px]">
            <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <p className="text-[11px] text-foreground/40 leading-relaxed">
          保存会直接写入磁盘上的 Markdown 文件。磁盘上只保留标准 Markdown 与
          frontmatter，Obsidian 等编辑器可直接读取。
        </p>
      </div>
    </div>
  )
}

/** 只读态下的编辑入口（无权限时显示升级提示而非按钮） */
export function EditToggle({
  canEdit,
  editing,
  onToggle,
}: {
  canEdit: boolean
  editing: boolean
  onToggle: () => void
}): React.ReactElement | null {
  if (!canEdit) {
    return (
      <span className="text-[11px] text-foreground/40" title="编辑笔记属于 Knowledge Pro 能力">
        编辑需订阅
      </span>
    )
  }
  if (editing) return null
  return (
    <Button variant="ghost" size="sm" onClick={onToggle}>
      <Check size={14} />
      编辑
    </Button>
  )
}

export default NoteEditor
