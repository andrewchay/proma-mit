import * as React from 'react'
import type { AgentWorkspace, ProjectWorkspaceBinding } from '@gravitas/shared'

/**
 * ProjectWorkspacesPanel - 项目「工作空间」面板
 *
 * 展示并维护 Project ↔ AgentWorkspace 的绑定关系：
 * - Project 是业务实体，AgentWorkspace 是执行环境；
 * - 绑定只是授权该工作区的会话在本项目检索记忆/资料，不自动共享任何文件；
 * - 后端接口为 window.electronAPI.paa.projectWorkspace（listByProject/bind/unbind）；
 *   接口缺失时面板降级为只读提示，不白屏、不报错。
 */

type ProjectWorkspaceApi = {
  listByProject: (projectId: string) => Promise<ProjectWorkspaceBinding[]>
  bind: (projectId: string, workspaceId: string) => Promise<ProjectWorkspaceBinding | null>
  unbind: (projectId: string, workspaceId: string) => Promise<boolean>
}

/** 容错获取绑定 API；未初始化时返回 null */
function getBindingApi(): ProjectWorkspaceApi | null {
  const api = (window as unknown as { electronAPI?: { paa?: { projectWorkspace?: ProjectWorkspaceApi } } }).electronAPI?.paa?.projectWorkspace
  return api && typeof api.listByProject === 'function' ? api : null
}

interface ProjectWorkspacesPanelProps {
  projectId: string
}

export function ProjectWorkspacesPanel({ projectId }: ProjectWorkspacesPanelProps): React.ReactElement {
  const [bindings, setBindings] = React.useState<ProjectWorkspaceBinding[]>([])
  const [workspaces, setWorkspaces] = React.useState<AgentWorkspace[]>([])
  const [selectedId, setSelectedId] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [apiMissing, setApiMissing] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setError(null)
    const api = getBindingApi()
    if (!api) {
      // 后端绑定接口尚未就绪：保留工作区目录，面板进入只读降级态
      setApiMissing(true)
      try {
        setWorkspaces(await window.electronAPI.listAgentWorkspaces())
      } catch {
        setWorkspaces([])
      }
      return
    }
    try {
      // 并行拉取绑定列表与全部工作区目录；目录失败不阻塞绑定展示
      const [bindingList, workspaceList] = await Promise.all([
        api.listByProject(projectId),
        window.electronAPI.listAgentWorkspaces().catch(() => [] as AgentWorkspace[]),
      ])
      setBindings(Array.isArray(bindingList) ? bindingList : [])
      setWorkspaces(workspaceList)
      setApiMissing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [projectId])

  React.useEffect(() => { void load() }, [load])

  /** 解析绑定记录的可读名称：以工作区目录为准，目录缺失时回退 ID */
  const resolveName = (binding: ProjectWorkspaceBinding): string => {
    return workspaces.find((workspace) => workspace.id === binding.workspaceId)?.name ?? binding.workspaceId
  }

  const boundIds = new Set(bindings.map((binding) => binding.workspaceId))
  const available = workspaces.filter((workspace) => !boundIds.has(workspace.id))

  const bind = async (): Promise<void> => {
    const api = getBindingApi()
    if (!api || !selectedId) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await api.bind(projectId, selectedId)
      setMessage('已绑定。该工作区的会话获得本项目的记忆检索授权，不会自动共享任何文件。')
      setSelectedId('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const unbind = async (workspaceId: string, name: string): Promise<void> => {
    const api = getBindingApi()
    if (!api) return
    if (!window.confirm(`解除「${name}」与本项目的绑定？\n\n解除后该工作区会话不再检索到本项目的记忆，历史已共享的资料不受影响。`)) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await api.unbind(projectId, workspaceId)
      setMessage(`已解除「${name}」的绑定。`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 p-1">
      <div className="text-xs text-muted-foreground">
        Agent 工作区是执行环境，绑定后仅授权其会话在本项目范围内检索记忆；
        绑定不等于共享资料，工作区文件与本项目数据互不自动同步。
      </div>

      {apiMissing && (
        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          项目-工作空间绑定接口尚未就绪。当前为只读预览，可查看工作区目录但无法绑定/解绑。
        </div>
      )}
      {error && <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</div>}
      {message && <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-700">{message}</div>}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium">已绑定工作空间（{bindings.length}）</div>
          <button
            onClick={() => void load()}
            disabled={busy}
            className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
          >刷新列表</button>
        </div>
        {bindings.length === 0 ? (
          <div className="rounded border border-dashed p-4 text-xs text-muted-foreground">
            尚未绑定任何工作空间。本项目暂无授权检索记忆的工作区。
          </div>
        ) : (
          <div className="space-y-2">
            {bindings.map((binding) => (
              <div key={binding.workspaceId} className="flex items-center gap-3 rounded border p-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{resolveName(binding)}</div>
                  <div className="text-xs text-muted-foreground">
                    {workspaces.find((workspace) => workspace.id === binding.workspaceId)?.slug ?? binding.workspaceId}
                    {binding.createdAt ? ` · 绑定于 ${new Date(binding.createdAt).toLocaleString()}` : ''}
                  </div>
                </div>
                <button
                  onClick={() => void unbind(binding.workspaceId, resolveName(binding))}
                  disabled={busy || apiMissing}
                  className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
                >解绑</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {available.length > 0 && !apiMissing && (
        <div>
          <div className="mb-2 text-sm font-medium">绑定现有工作空间</div>
          <div className="flex items-center gap-2">
            <select
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
              disabled={busy}
              className="h-8 rounded border border-input bg-transparent px-2 text-xs"
            >
              <option value="">选择工作区…</option>
              {available.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}{workspace.rootPath ? '（本地项目）' : ''}
                </option>
              ))}
            </select>
            <button
              onClick={() => void bind()}
              disabled={busy || !selectedId}
              className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
            >绑定</button>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            没有合适的工作区？请到 Agent 工作区设置中创建。
          </div>
        </div>
      )}
    </div>
  )
}
