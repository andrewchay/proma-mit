/**
 * KnowledgeModuleView — 知识库工作区（免费版索引模式）
 *
 * 免费版能力 knowledge-basic 的界面入口：只读地索引本地 Markdown 目录，
 * 提供全文搜索、标签过滤、笔记阅读与图谱概览。
 *
 * 边界：这里不写入用户的 Markdown 源文件。编辑能力属于 Knowledge Pro
 * 插件，当前版本未提供，UI 中不给出会造成误导的编辑入口。
 */
import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  BookOpen,
  FileText,
  FolderPlus,
  Hash,
  Link2,
  Loader2,
  Network,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  knowledgeVaultsAtom,
  selectedVaultIdAtom,
  selectedVaultAtom,
  knowledgeNotesAtom,
  activeNoteAtom,
  knowledgeSearchResultsAtom,
  knowledgeSearchQueryAtom,
  knowledgeTagsAtom,
  selectedTagAtom,
  knowledgeGraphAtom,
  knowledgeLoadingAtom,
  knowledgeIndexingAtom,
  knowledgeErrorAtom,
  knowledgeIndexNoticeAtom,
  visibleNotesAtom,
  refreshKnowledge,
  indexVault,
  indexAllVaults,
} from '@/atoms/knowledge-atoms'

/** 相对时间：用于展示笔记的索引/更新时间 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

export function KnowledgeModuleView(): React.ReactElement {
  const [vaults, setVaults] = useAtom(knowledgeVaultsAtom)
  const [selectedVaultId, setSelectedVaultId] = useAtom(selectedVaultIdAtom)
  const selectedVault = useAtomValue(selectedVaultAtom)
  const setNotes = useSetAtom(knowledgeNotesAtom)
  const [activeNote, setActiveNote] = useAtom(activeNoteAtom)
  const [searchResults, setSearchResults] = useAtom(knowledgeSearchResultsAtom)
  const [searchQuery, setSearchQuery] = useAtom(knowledgeSearchQueryAtom)
  const [tags, setTags] = useAtom(knowledgeTagsAtom)
  const [selectedTag, setSelectedTag] = useAtom(selectedTagAtom)
  const [graph, setGraph] = useAtom(knowledgeGraphAtom)
  const [loading, setLoading] = useAtom(knowledgeLoadingAtom)
  const [indexing, setIndexing] = useAtom(knowledgeIndexingAtom)
  const [error, setError] = useAtom(knowledgeErrorAtom)
  const [notice, setNotice] = useAtom(knowledgeIndexNoticeAtom)
  const visibleNotes = useAtomValue(visibleNotesAtom)

  const [addOpen, setAddOpen] = React.useState(false)
  const [vaultName, setVaultName] = React.useState('')
  const [vaultPath, setVaultPath] = React.useState('')
  const [creating, setCreating] = React.useState(false)

  const api = window.electronAPI?.knowledge

  /** 统一包装异步操作：集中处理 loading 与错误 */
  const run = React.useCallback(
    async (fn: () => Promise<void>) => {
      setLoading(true)
      setError(null)
      try {
        await fn()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [setLoading, setError],
  )

  /** 拉取 Vault / 笔记 / 标签 */
  const loadAll = React.useCallback(
    () =>
      run(async () => {
        const data = await refreshKnowledge()
        setVaults(data.vaults)
        setNotes(data.notes)
        setTags(data.tags)
      }),
    [run, setVaults, setNotes, setTags],
  )

  React.useEffect(() => {
    void loadAll()
  }, [loadAll])

  /** 切换 Vault 时刷新笔记、标签与图谱（服务端按 vaultId 过滤） */
  React.useEffect(() => {
    if (!api) return
    void run(async () => {
      const vaultId = selectedVaultId ?? undefined
      const [notes, tagList, graphData] = await Promise.all([
        api.listNotes(vaultId),
        api.getAllTags(vaultId),
        api.getGraph(vaultId),
      ])
      setNotes(notes)
      setTags(tagList)
      setGraph(graphData)
      // 切换 Vault 后清空搜索与选中笔记，避免展示上一 Vault 的内容
      setSearchQuery('')
      setSearchResults([])
      setSelectedTag(null)
      setActiveNote(null)
    })
  }, [selectedVaultId, api, run, setNotes, setTags, setGraph, setSearchQuery, setSearchResults, setSelectedTag, setActiveNote])

  /** 全文搜索（输入变化时防抖触发） */
  React.useEffect(() => {
    if (!api) return
    const query = searchQuery.trim()
    if (!query) {
      setSearchResults([])
      return
    }
    const timer = setTimeout(() => {
      void run(async () => {
        const results = await api.searchNotes(query, selectedVaultId ?? undefined)
        setSearchResults(results)
      })
    }, 250)
    return () => clearTimeout(timer)
  }, [searchQuery, selectedVaultId, api, run, setSearchResults])

  /** 选择 Vault 目录 */
  const pickFolder = async (): Promise<void> => {
    const picked = await window.electronAPI.openFolderDialog()
    if (picked) {
      setVaultPath(picked.path)
      if (!vaultName.trim()) setVaultName(picked.name)
    }
  }

  /** 创建 Vault 并立即索引 */
  const createVault = async (): Promise<void> => {
    if (!api || !vaultPath.trim() || !vaultName.trim()) return
    setCreating(true)
    try {
      const vault = await api.createVault({
        name: vaultName.trim(),
        path: vaultPath.trim(),
        type: 'folder',
        enabled: true,
      })
      setVaults((prev) => [...prev, vault])
      setAddOpen(false)
      setVaultName('')
      setVaultPath('')
      setSelectedVaultId(vault.id)

      const message = await indexVault(vault.id, vault.name)
      setNotice(message)
      const data = await refreshKnowledge()
      setNotes(data.notes)
      setTags(data.tags)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  /** 索引当前 Vault（未选中则索引全部） */
  const handleIndex = async (): Promise<void> => {
    if (!api) return
    setIndexing(true)
    setError(null)
    try {
      const message = selectedVault
        ? await indexVault(selectedVault.id, selectedVault.name)
        : await indexAllVaults()
      setNotice(message)
      const data = await refreshKnowledge()
      setVaults(data.vaults)
      setNotes(data.notes)
      setTags(data.tags)
      const graphData = await api.getGraph(selectedVaultId ?? undefined)
      setGraph(graphData)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIndexing(false)
    }
  }

  /** 删除 Vault（仅移除索引，不删除磁盘上的 Markdown 文件） */
  const removeVault = async (id: string, name: string): Promise<void> => {
    if (!api) return
    const confirmed = window.confirm(
      `确定移除知识库「${name}」？\n\n只会删除本地索引，磁盘上的 Markdown 文件不受影响。`,
    )
    if (!confirmed) return
    await run(async () => {
      await api.deleteVault(id)
      if (selectedVaultId === id) setSelectedVaultId(null)
      const data = await refreshKnowledge()
      setVaults(data.vaults)
      setNotes(data.notes)
      setTags(data.tags)
    })
  }

  /** 打开笔记详情 */
  const openNote = async (noteId: string): Promise<void> => {
    if (!api) return
    await run(async () => {
      const note = await api.getNote(noteId)
      setActiveNote(note)
    })
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶部：Vault 选择与索引操作 */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 flex-shrink-0">
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground/75">
          <BookOpen size={15} className="text-foreground/45" />
          知识库
        </div>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => setAddOpen(true)} disabled={!api}>
          <FolderPlus size={14} />
          添加目录
        </Button>
        <Button variant="ghost" size="sm" onClick={handleIndex} disabled={!api || indexing}>
          {indexing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {indexing ? '索引中…' : selectedVault ? '索引当前' : '索引全部'}
        </Button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 左侧：Vault + 标签 */}
        <div className="w-56 border-r border-border/50 flex flex-col flex-shrink-0">
          <div className="px-3 py-2 text-[11px] font-medium text-foreground/45 tracking-wide">
            全部知识库
          </div>
          <div className="px-2 pb-2 space-y-0.5">
            <button
              onClick={() => setSelectedVaultId(null)}
              className={`w-full text-left px-2.5 py-1.5 rounded-md text-[13px] transition-colors ${
                selectedVaultId === null
                  ? 'bg-foreground/[0.08] text-foreground/90'
                  : 'text-foreground/65 hover:bg-foreground/[0.05]'
              }`}
            >
              全部笔记
              <span className="ml-1 text-foreground/40">{visibleNotes.length}</span>
            </button>
            {vaults.map((vault) => (
              <div key={vault.id} className="group flex items-center">
                <button
                  onClick={() => setSelectedVaultId(vault.id)}
                  className={`flex-1 min-w-0 text-left px-2.5 py-1.5 rounded-md text-[13px] transition-colors ${
                    selectedVaultId === vault.id
                      ? 'bg-foreground/[0.08] text-foreground/90'
                      : 'text-foreground/65 hover:bg-foreground/[0.05]'
                  }`}
                  title={vault.path}
                >
                  <span className="truncate block">{vault.name}</span>
                  {vault.lastIndexedAt && (
                    <span className="text-[11px] text-foreground/40">
                      {relativeTime(vault.lastIndexedAt)}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => removeVault(vault.id, vault.name)}
                  className="opacity-0 group-hover:opacity-100 p-1.5 rounded text-foreground/40 hover:text-destructive transition-all"
                  title="移除知识库"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>

          {tags.length > 0 && (
            <>
              <div className="px-3 py-2 text-[11px] font-medium text-foreground/45 tracking-wide border-t border-border/50">
                标签
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
                <div className="flex flex-wrap gap-1">
                  {tags.slice(0, 40).map(({ tag, count }) => (
                    <button
                      key={tag}
                      onClick={() => {
                        setSelectedTag(selectedTag === tag ? null : tag)
                        setSearchQuery('')
                      }}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors ${
                        selectedTag === tag
                          ? 'bg-primary/15 text-primary'
                          : 'bg-foreground/[0.05] text-foreground/60 hover:bg-foreground/[0.09]'
                      }`}
                    >
                      <Hash size={10} />
                      {tag}
                      <span className="text-foreground/40">{count}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* 中间：搜索 + 笔记列表 */}
        <div className="w-80 border-r border-border/50 flex flex-col flex-shrink-0">
          <div className="p-2.5 border-b border-border/50">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground/35" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索笔记标题、正文或标签"
                className="h-8 pl-8 pr-8 text-[13px]"
                disabled={!api}
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground/40 hover:text-foreground/70"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {loading && visibleNotes.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-foreground/40">
                <Loader2 size={16} className="animate-spin" />
              </div>
            ) : visibleNotes.length === 0 ? (
              <EmptyState
                hasVaults={vaults.length > 0}
                searching={searchQuery.trim().length > 0}
                onAdd={() => setAddOpen(true)}
              />
            ) : (
              <div className="p-1.5 space-y-0.5">
                {visibleNotes.map((note) => (
                  <button
                    key={note.id}
                    onClick={() => openNote(note.id)}
                    className={`w-full text-left px-2.5 py-2 rounded-md transition-colors ${
                      activeNote?.id === note.id
                        ? 'bg-foreground/[0.08]'
                        : 'hover:bg-foreground/[0.05]'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <FileText size={12} className="text-foreground/35 flex-shrink-0" />
                      <span className="text-[13px] text-foreground/85 truncate">{note.title}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-foreground/40">
                      <span>{note.wordCount} 字</span>
                      {note.links.length > 0 && (
                        <span className="inline-flex items-center gap-0.5">
                          <Link2 size={9} />
                          {note.links.length}
                        </span>
                      )}
                      <span>{relativeTime(note.updatedAt)}</span>
                    </div>
                    {note.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {note.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="px-1.5 py-px rounded bg-foreground/[0.06] text-[10px] text-foreground/55"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 右侧：笔记详情 */}
        <div className="flex-1 min-w-0 flex flex-col">
          {activeNote ? (
            <NoteDetail
              note={activeNote}
              onOpenLinked={(title) => {
                // wikilink 导航：按标题在已索引笔记中查找
                const target = visibleNotes.find(
                  (n) => n.title.toLowerCase() === title.toLowerCase(),
                )
                if (target) void openNote(target.id)
              }}
              onClose={() => setActiveNote(null)}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-foreground/35">
              <Network size={28} className="text-foreground/20" />
              <div className="text-[13px]">选择左侧笔记查看内容</div>
              {graph.nodes.length > 0 && (
                <div className="text-[11px] text-foreground/30">
                  当前范围含 {graph.nodes.length} 个节点、{graph.edges.length} 条关联
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 状态提示条 */}
      {(error || notice) && (
        <div
          className={`px-4 py-1.5 text-[12px] flex items-center gap-2 border-t border-border/50 ${
            error ? 'text-destructive' : 'text-foreground/60'
          }`}
        >
          <span className="flex-1 truncate">{error ?? notice}</span>
          <button
            onClick={() => {
              setError(null)
              setNotice(null)
            }}
            className="text-foreground/40 hover:text-foreground/70"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* 添加知识库对话框 */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>添加知识库目录</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <label className="text-[12px] text-foreground/60">名称</label>
              <Input
                value={vaultName}
                onChange={(e) => setVaultName(e.target.value)}
                placeholder="例如：研究笔记"
                className="mt-1 h-8 text-[13px]"
              />
            </div>
            <div>
              <label className="text-[12px] text-foreground/60">目录</label>
              <div className="mt-1 flex gap-2">
                <Input
                  value={vaultPath}
                  onChange={(e) => setVaultPath(e.target.value)}
                  placeholder="选择或输入 Markdown 目录"
                  className="h-8 text-[13px]"
                />
                <Button variant="outline" size="sm" onClick={pickFolder}>
                  选择…
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-foreground/45 leading-relaxed">
              索引只读取该目录下的 Markdown 文件，不会修改或移动你的原始文件。
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={createVault}
              disabled={creating || !vaultName.trim() || !vaultPath.trim()}
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : null}
              添加并索引
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 空状态：区分「尚未添加目录」与「搜索无结果」 */
function EmptyState({
  hasVaults,
  searching,
  onAdd,
}: {
  hasVaults: boolean
  searching: boolean
  onAdd: () => void
}): React.ReactElement {
  if (searching) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-foreground/40">
        <Search size={20} className="text-foreground/20" />
        <div className="text-[13px]">没有匹配的笔记</div>
      </div>
    )
  }
  if (!hasVaults) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <FolderPlus size={24} className="text-foreground/20" />
        <div className="text-[13px] text-foreground/55">还没有知识库</div>
        <p className="text-[12px] text-foreground/40 leading-relaxed">
          添加一个 Markdown 目录后，这里会索引其中的笔记，供搜索与 Agent 引用。
        </p>
        <Button variant="outline" size="sm" onClick={onAdd}>
          添加目录
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-foreground/40">
      <FileText size={20} className="text-foreground/20" />
      <div className="text-[13px]">该范围下暂无已索引笔记</div>
      <div className="text-[11px] text-foreground/30">点击右上角「索引」重建索引</div>
    </div>
  )
}

/** 笔记详情：正文阅读 + frontmatter + 标签 + 出链/反链 */
function NoteDetail({
  note,
  onOpenLinked,
  onClose,
}: {
  note: import('@gravitas/shared').KnowledgeNote
  onOpenLinked: (title: string) => void
  onClose: () => void
}): React.ReactElement {
  const frontmatterEntries = Object.entries(note.frontmatter ?? {})

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-start gap-3 px-5 py-3 border-b border-border/50 flex-shrink-0">
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-medium text-foreground/90 truncate">{note.title}</h2>
          <div className="mt-1 flex items-center gap-3 text-[11px] text-foreground/45">
            <span>{note.filePath}</span>
            <span>{note.wordCount} 字</span>
            <span>更新于 {relativeTime(note.updatedAt)}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded text-foreground/40 hover:text-foreground/70 hover:bg-foreground/[0.05]"
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {(frontmatterEntries.length > 0 || note.tags.length > 0) && (
          <div className="mb-4 space-y-2">
            {frontmatterEntries.length > 0 && (
              <div className="rounded-lg bg-foreground/[0.03] px-3 py-2">
                <div className="text-[11px] font-medium text-foreground/45 mb-1.5">Properties</div>
                <dl className="space-y-1">
                  {frontmatterEntries.map(([key, value]) => (
                    <div key={key} className="flex gap-2 text-[12px]">
                      <dt className="text-foreground/50 flex-shrink-0">{key}</dt>
                      <dd className="text-foreground/80 break-all">{formatValue(value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            {note.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {note.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-foreground/[0.06] text-[11px] text-foreground/60"
                  >
                    <Hash size={10} />
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-foreground/85">
          {note.content}
        </pre>

        {note.links.length > 0 && (
          <div className="mt-5 pt-4 border-t border-border/50">
            <div className="text-[11px] font-medium text-foreground/45 mb-2">
              出链（{note.links.length}）
            </div>
            <div className="flex flex-wrap gap-1.5">
              {note.links.map((link) => (
                <button
                  key={link}
                  onClick={() => onOpenLinked(link)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 text-primary text-[11px] hover:bg-primary/15 transition-colors"
                >
                  <Link2 size={10} />
                  {link}
                </button>
              ))}
            </div>
          </div>
        )}

        {note.backlinks.length > 0 && (
          <div className="mt-4">
            <div className="text-[11px] font-medium text-foreground/45 mb-2">
              反向链接（{note.backlinks.length}）
            </div>
            <div className="flex flex-wrap gap-1.5">
              {note.backlinks.map((link) => (
                <span
                  key={link}
                  className="px-2 py-0.5 rounded bg-foreground/[0.05] text-[11px] text-foreground/60"
                >
                  {link}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** frontmatter 值转可读文本 */
function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export default KnowledgeModuleView
