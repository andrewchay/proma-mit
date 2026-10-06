import * as React from 'react'

/**
 * Project 知识面板（K1-05）
 *
 * 管理「这个 Project 允许使用哪些知识库」。这是 Agent 知识范围的唯一
 * 配置入口：绑定关系保存在知识目录（knowledge-catalog-service），会话以
 * project 模式解析范围时实时读取这里的结果。
 *
 * 展示原则：解除关联 ≠ 删除。解除只影响本 Project 的可见范围，知识库
 * 与原件不动；删除知识库必须去全局知识页面且带显式确认。
 */

interface KnowledgeBaseLike {
  id: string
  name: string
  description?: string
  enabled: boolean
}

interface ProjectKnowledgePanelProps {
  projectId: string
}

export function ProjectKnowledgePanel({ projectId }: ProjectKnowledgePanelProps): React.ReactElement {
  const api = window.electronAPI?.knowledge

  const [bound, setBound] = React.useState<KnowledgeBaseLike[]>([])
  const [all, setAll] = React.useState<KnowledgeBaseLike[]>([])
  const [selectedId, setSelectedId] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [graphKnowledgeBaseId, setGraphKnowledgeBaseId] = React.useState('')
  const [graphStatus, setGraphStatus] = React.useState<{ available: boolean; queryable?: boolean; record?: unknown } | null>(null)
  const [graphBuilding, setGraphBuilding] = React.useState(false)

  const refreshGraphStatus = React.useCallback(async () => {
    if (!api?.getGraphBuildStatus || !graphKnowledgeBaseId) {
      setGraphStatus(null)
      return
    }
    try {
      setGraphStatus(await api.getGraphBuildStatus(graphKnowledgeBaseId))
    } catch { setGraphStatus({ available: false }) }
  }, [api, graphKnowledgeBaseId])

  const buildGraph = async (): Promise<void> => {
    if (!api?.buildKnowledgeGraph || !graphKnowledgeBaseId) return
    setGraphBuilding(true)
    setError(null)
    try {
      const res = await api.buildKnowledgeGraph(graphKnowledgeBaseId)
      if (res.error) setError(res.error)
      await refreshGraphStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGraphBuilding(false)
    }
  }

  const load = React.useCallback(async () => {
    if (!api) return
    try {
      const [boundList, catalog] = await Promise.all([
        api.listProjectKnowledgeBases(projectId),
        api.readCatalog(),
      ])
      setBound(boundList)
      setAll(catalog.knowledgeBases)
      setGraphKnowledgeBaseId((current) => (
        boundList.some((kb) => kb.id === current) ? current : (boundList[0]?.id ?? '')
      ))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [api, projectId])

  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => { void refreshGraphStatus() }, [refreshGraphStatus])

  const bind = async (): Promise<void> => {
    if (!api || !selectedId) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await api.bindProject({ projectId, knowledgeBaseId: selectedId })
      setMessage('已关联。本 Project 的 Agent 会话（project 模式）现在可以检索该知识库。')
      setSelectedId('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const unbind = async (knowledgeBaseId: string, name: string): Promise<void> => {
    if (!api) return
    if (!window.confirm(`解除「${name}」与本 Project 的关联？\n\n解除后本 Project 的会话将无法检索该知识库，但知识库与原文件不受影响。`)) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await api.unbindProject({ projectId, knowledgeBaseId })
      setMessage(`已解除「${name}」的关联。`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const available = all.filter((kb) => !bound.some((b) => b.id === kb.id))

  return (
    <div className="space-y-4 p-1">
      <div className="text-xs text-muted-foreground">
        关联的知识库决定本 Project 会话（project 知识模式）可检索的资料范围。
        Agent 只能检索此处列出的知识库；解除关联立即生效，但不会删除任何文件。
      </div>

      {error && <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</div>}
      {message && <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-700">{message}</div>}

      <div>
        <div className="mb-2 text-sm font-medium">AOF 语义图谱（本地，可选）</div>
        <div className="mb-2 rounded border bg-muted/30 p-2 text-[11px] text-muted-foreground">
          构建在本地 AOF 治理链路中完成，角色标签为本地流程字段，非认证身份；
          检索结果可作参考线索，不是事实保证。AOF 不可用时基础检索完全不受影响。
        </div>
        {bound.length === 0 ? (
          <div className="text-xs text-muted-foreground">请先为 Project 关联知识库，再选择知识库构建图谱。</div>
        ) : (
          <div className="flex items-center gap-2">
            <select
              value={graphKnowledgeBaseId}
              onChange={(event) => {
                setGraphKnowledgeBaseId(event.target.value)
                setGraphStatus(null)
              }}
              disabled={busy || graphBuilding}
              aria-label="图谱知识库"
              className="h-8 rounded border border-input bg-transparent px-2 text-xs"
            >
              {bound.map((kb) => <option key={kb.id} value={kb.id}>{kb.name}</option>)}
            </select>
            <button
              onClick={() => void refreshGraphStatus()}
              disabled={busy || graphBuilding || !graphKnowledgeBaseId}
              className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
            >刷新状态</button>
            {graphStatus?.available === false ? (
              <span className="text-xs text-muted-foreground">本机未检测到 AOF 环境，语义图谱不可用。</span>
            ) : (
              <button
                onClick={() => void buildGraph()}
                disabled={busy || graphBuilding || !graphKnowledgeBaseId}
                className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
              >{graphBuilding ? '构建中…' : graphStatus?.queryable ? '重新构建' : '构建图谱'}</button>
            )}
          </div>
        )}
        {graphStatus?.record != null && (() => {
          const rec = graphStatus.record as { state?: string; releaseDigest?: string; error?: string }
          const digestShort = typeof rec.releaseDigest === 'string' ? rec.releaseDigest.slice(7, 19) : ''
          return (
            <div className="mt-2 text-xs">
              状态：<span className="font-medium">{rec.state ?? 'unknown'}</span>
              {digestShort && <span className="ml-2 text-muted-foreground">release {digestShort}</span>}
              {rec.error && <div className="mt-1 text-red-600">{rec.error}</div>}
            </div>
          )
        })()}
      </div>

      <div>
        <div className="mb-2 text-sm font-medium">已关联（{bound.length}）</div>
        {bound.length === 0 ? (
          <div className="rounded border border-dashed p-4 text-xs text-muted-foreground">
            尚未关联知识库。本 Project 的会话默认无法检索任何资料。
          </div>
        ) : (
          <div className="space-y-2">
            {bound.map((kb) => (
              <div key={kb.id} className="flex items-center gap-3 rounded border p-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{kb.name}{!kb.enabled && <span className="ml-2 text-xs text-amber-600">已停用</span>}</div>
                  {kb.description && <div className="truncate text-xs text-muted-foreground">{kb.description}</div>}
                </div>
                <button
                  onClick={() => void unbind(kb.id, kb.name)}
                  disabled={busy}
                  className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
                >解除关联</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {available.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-medium">关联新知识库</div>
          <div className="flex items-center gap-2">
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="h-8 rounded border border-input bg-transparent px-2 text-xs"
            >
              <option value="">选择知识库…</option>
              {available.map((kb) => (
                <option key={kb.id} value={kb.id}>{kb.name}{!kb.enabled ? '（已停用）' : ''}</option>
              ))}
            </select>
            <button
              onClick={() => void bind()}
              disabled={busy || !selectedId}
              className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
            >关联</button>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            没有合适的知识库？请到全局「知识」页面创建或管理。
          </div>
        </div>
      )}
    </div>
  )
}
