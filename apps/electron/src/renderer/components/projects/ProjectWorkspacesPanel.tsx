import * as React from 'react'
import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai'
import { workspaceFilesVersionAtom } from '../../atoms/agent-atoms'
import { editOwnerMessageAtom, getOwnerMessageComposer, ownerConversationNavigationAtom, ownerMessageComposersAtom } from '../../atoms/project-owner-management-atoms'
import type { AgentWorkspace, ProjectWorkspaceBinding, ProjectWorkspaceFileChangesView, ProjectWorkspaceGitDiff, ProjectFileChangePolicy } from '@gravitas/shared'
import { prepareProjectChangeMessage } from './project-file-change-message'

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
  const changesAtom = React.useMemo(() => atom<Record<string, ProjectWorkspaceFileChangesView>>({}), [])
  const [changes, setChanges] = useAtom(changesAtom)
  const policiesAtom = React.useMemo(() => atom<Record<string, ProjectFileChangePolicy | null>>({}), [])
  const [policies, setPolicies] = useAtom(policiesAtom)
  const filesVersion = useAtomValue(workspaceFilesVersionAtom)
  const diffAtom = React.useMemo(() => atom<{ workspaceId: string; path: string; result: ProjectWorkspaceGitDiff | null } | null>(null), [])
  const [diff, setDiff] = useAtom(diffAtom)
  const diffRequest = React.useRef(0)
  const composers = useAtomValue(ownerMessageComposersAtom)
  const editOwnerMessage = useSetAtom(editOwnerMessageAtom)
  const navigateOwner = useSetAtom(ownerConversationNavigationAtom)

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

  React.useEffect(() => {
    // 文件变化事件用于刷新可能失效的分析授权。
    void filesVersion
    if (busy) return
    const policyApi = window.electronAPI?.paa?.projectWorkspace?.getFileChangePolicy
    if (!policyApi) return
    let cancelled = false
    void Promise.all(bindings.map(async binding => [binding.workspaceId, await policyApi(projectId, binding.workspaceId)] as const))
      .then(entries => { if (!cancelled) setPolicies(Object.fromEntries(entries)) })
      .catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)) })
    return () => { cancelled = true }
  }, [bindings, busy, filesVersion, projectId, setPolicies])

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
      diffRequest.current++
      setDiff(null)
      setChanges(previous => { const next = { ...previous }; delete next[workspaceId]; return next })
      setMessage(`已解除「${name}」的绑定。`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const showChanges = async (workspaceId: string): Promise<void> => {
    setError(null)
    try {
      const events = await window.electronAPI.paa.projectWorkspace.listFileChanges(projectId, workspaceId)
      setChanges(previous => ({ ...previous, [workspaceId]: events }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const changePolicy = async (workspaceId: string, enabled: boolean): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const policy = await window.electronAPI.paa.projectWorkspace.setFileChangePolicy(projectId, workspaceId, enabled)
      setPolicies(previous => ({ ...previous, [workspaceId]: policy }))
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const showGitDiff = async (workspaceId: string, path: string): Promise<void> => {
    const request = ++diffRequest.current
    setDiff({ workspaceId, path, result: null })
    try {
      const result = await window.electronAPI.paa.projectWorkspace.getGitDiff(projectId, workspaceId, path)
      if (request === diffRequest.current) setDiff({ workspaceId, path, result })
    } catch (error) {
      if (request === diffRequest.current) setDiff({ workspaceId, path, result: { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) } })
    }
  }

  const prepareOwnerAnalysis = (workspaceId: string): void => {
    const events = changes[workspaceId]?.changes.slice(0, 20) ?? []
    if (!events.length) return
    const subject = { projectId }
    const composer = getOwnerMessageComposer(composers, subject)
    if (composer.pending || composer.sending) { setError('当前 Owner 消息正在处理，请稍后再添加变化记录。'); return }
    const text = prepareProjectChangeMessage(composer.text, events)
    if (text === null) { setError('Owner 消息草稿空间不足，请先整理现有草稿。'); return }
    editOwnerMessage({ subject, text })
    navigateOwner({ projectId, at: Date.now() })
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
              <div key={binding.workspaceId} className="rounded border p-3">
                <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{resolveName(binding)}</div>
                  <div className="text-xs text-muted-foreground">
                    {workspaces.find((workspace) => workspace.id === binding.workspaceId)?.slug ?? binding.workspaceId}
                    {binding.createdAt ? ` · 绑定于 ${new Date(binding.createdAt).toLocaleString()}` : ''}
                  </div>
                </div>
                {workspaces.find(workspace => workspace.id === binding.workspaceId)?.rootPath && <button
                  type="button" onClick={() => void showChanges(binding.workspaceId)}
                  className="rounded px-2 py-1 text-xs text-primary hover:bg-muted"
                >查看文件变化</button>}
                <button
                  onClick={() => void unbind(binding.workspaceId, resolveName(binding))}
                  disabled={busy || apiMissing}
                  className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
                >解绑</button>
                </div>
                {workspaces.find(workspace => workspace.id === binding.workspaceId)?.rootPath && Object.hasOwn(policies, binding.workspaceId) && <label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={Boolean(policies[binding.workspaceId])} disabled={busy} onChange={event => void changePolicy(binding.workspaceId, event.target.checked)} />
                  <span>允许 Owner 自动分析之后的文件变化。路径及变化摘要会用于模型分析；需已有有效管理授权和预算，不会自动修改任务或派工。关闭、解绑、忽略规则或目录身份变化、无法核对范围时不再启动旧观察；升级或范围变化后可能需要重新开启；无法识别目录身份时不能开启。</span>
                </label>}
                {Object.hasOwn(changes, binding.workspaceId) && <div className="mt-3 rounded-lg bg-muted/40 p-3 text-xs">
                  <p className="text-muted-foreground">最近最多 100 条记录，仅供查看；首次扫描建立基线，未包含文件正文，也未发送给 Owner。</p>
                  {(changes[binding.workspaceId]?.changes.length ?? 0) > 0 && <button type="button" className="mt-2 text-primary underline" onClick={() => prepareOwnerAnalysis(binding.workspaceId)}>将最近 20 条加入 Owner 消息草稿</button>}
                  {!changes[binding.workspaceId]!.watching && <p role="alert" className="mt-2 text-destructive">目录监听未运行，新的变化可能无法及时记录。</p>}
                  {changes[binding.workspaceId]!.scanError && <p role="alert" className="mt-2 text-destructive">最近扫描失败，记录可能过期：{changes[binding.workspaceId]!.scanError}</p>}
                  <p className="mt-2 text-muted-foreground">{changes[binding.workspaceId]!.lastScannedAt ? `上次成功扫描：${new Date(changes[binding.workspaceId]!.lastScannedAt!).toLocaleString()}` : '尚无可确认的成功扫描时间。'}</p>
                  {changes[binding.workspaceId]!.baselineReset && <p className="mt-2 text-muted-foreground">{changes[binding.workspaceId]!.baselineReset!.reason === 'ignore_changed' ? '忽略规则变化后已重新建立基线，该次扫描不会记录规则变更期间的文件变化' : '首次扫描已建立基线，此前的变化未被记录'}：{new Date(changes[binding.workspaceId]!.baselineReset!.at).toLocaleString()}</p>}
                  {changes[binding.workspaceId]!.changes.length === 0 ? <p className="mt-2">暂无已记录变化。</p> : <ul className="mt-2 max-h-64 space-y-1 overflow-auto">{changes[binding.workspaceId]!.changes.map((change, index) => <li key={`${change.observedAt}-${index}`} className="break-all">{new Date(change.observedAt).toLocaleString()} · {change.kind === 'added' ? '新增' : change.kind === 'deleted' ? '删除' : change.kind === 'renamed' ? '疑似重命名' : '修改'} · {change.previousPath ? `${change.previousPath} → ` : ''}{change.path} · {change.evidence === 'content' ? '内容摘要' : change.evidence === 'matching_digest' ? '摘要匹配推测' : '元数据'} <button type="button" className="text-primary underline" onClick={() => void showGitDiff(binding.workspaceId, change.path)}>查看当前 Git 差异</button></li>)}</ul>}
                  {diff?.workspaceId === binding.workspaceId && <section className="mt-3 rounded bg-background p-3" aria-label="当前 Git 差异">
                    <p className="font-medium">{diff.path} · 当前工作区相对 HEAD</p>
                    <p className="mt-1 text-muted-foreground">这不是上述历史事件的精确差异，也不会自动发送给 Owner。</p>
                    {!diff.result ? <p className="mt-2">正在读取…</p> : diff.result.status === 'unavailable' ? <p className="mt-2">{diff.result.reason}</p> : <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all">{diff.result.text}</pre>}
                  </section>}
                </div>}
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
