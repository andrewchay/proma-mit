/**
 * WorkflowSidebarList — 工作流模式下的左侧列表
 *
 * 承载 Workflow 工作台的「列表」职责（本地模板 / 我的 Workflow / 运行历史），
 * 替代原 WorkflowView 全屏三栏左侧的 aside，将其并入应用左侧边栏：
 *
 * - 切到「工作流」模式时，侧边栏此区块替换「进行中的项目」。
 * - 底部「工作模块」由 LeftSidebar 保留，不在此组件内渲染。
 * - 点击某个 Workflow / Run 后将 draft / selectedId / runs 写入共享 atoms，
 *   MainArea 中的 WorkflowView（纯画布编辑器）随之联动。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Upload, Plus, X } from 'lucide-react'
import type { WorkflowDefinition, WorkflowTemplate } from '@gravitas/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import {
  workflowDefinitionsAtom,
  workflowDraftAtom,
  workflowLatestRunAtom,
  workflowLoadingAtom,
  workflowRunEventsAtom,
  workflowRunsAtom,
  selectedWorkflowIdAtom,
  selectedWorkflowRunIdAtom,
  workflowTemplatesAtom,
} from '@/atoms/workflow-atoms'
import { activeViewAtom } from '@/atoms/active-view'

function createWorkflow(workspaceId: string): WorkflowDefinition {
  const now = Date.now()
  const id = `workflow-${crypto.randomUUID()}`
  return {
    format: 'paa.workflow',
    formatVersion: '1.0',
    id,
    workspaceId,
    name: '未命名 Workflow',
    status: 'draft',
    version: '0.1.0',
    trigger: { kind: 'manual' },
    nodes: [
      { id: 'start', kind: 'start', title: '开始' },
      { id: 'end', kind: 'end', title: '结束' },
    ],
    edges: [{ id: 'start-to-end', from: 'start', to: 'end' }],
    layout: { nodes: { start: { x: 70, y: 180 }, end: { x: 680, y: 180 } } },
    createdAt: now,
    updatedAt: now,
  }
}

export function WorkflowSidebarList(): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const [definitions, setDefinitions] = useAtom(workflowDefinitionsAtom)
  const [selectedId, setSelectedId] = useAtom(selectedWorkflowIdAtom)
  const [draft, setDraft] = useAtom(workflowDraftAtom)
  const [loading, setLoading] = useAtom(workflowLoadingAtom)
  const [templates, setTemplates] = useAtom(workflowTemplatesAtom)
  const [latestRun, setLatestRun] = useAtom(workflowLatestRunAtom)
  const [runs, setRuns] = useAtom(workflowRunsAtom)
  const [selectedRunId, setSelectedRunId] = useAtom(selectedWorkflowRunIdAtom)
  const [runEvents, setRunEvents] = useAtom(workflowRunEventsAtom)

  const loadTemplates = React.useCallback(async () => {
    try { setTemplates(await window.electronAPI.listWorkflowTemplates()) } catch { /* 模板失败不阻断列表 */ }
  }, [setTemplates])

  const loadDefinitions = React.useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.electronAPI.listWorkflowDefinitions()
      setDefinitions(list)
      if (!selectedId && list[0]) {
        setSelectedId(list[0].id)
        setDraft(list[0])
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取 Workflow 失败')
    } finally {
      setLoading(false)
    }
  }, [selectedId, setDefinitions, setDraft, setLoading, setSelectedId])

  React.useEffect(() => { void loadDefinitions() }, [loadDefinitions])
  React.useEffect(() => { void loadTemplates() }, [loadTemplates])

  const loadRunHistory = React.useCallback(async (workflowId: string, focusRunId?: string) => {
    try {
      const list = await window.electronAPI.listWorkflowRuns(workflowId)
      setRuns(list)
      const targetId = focusRunId ?? selectedRunId ?? list[0]?.id
      if (!targetId) { setRunEvents([]); return }
      setSelectedRunId(targetId)
      const events = await window.electronAPI.listWorkflowRunEvents(workflowId, targetId)
      setRunEvents(events)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取 Run 历史失败')
    }
  }, [selectedRunId, setRunEvents, setRuns, setSelectedRunId])

  React.useEffect(() => {
    if (!draft) { setRuns([]); setRunEvents([]); return }
    void loadRunHistory(draft.id)
    // 依赖 draft?.id 与 latestRun?.id：新建/切换 Workflow 或编辑器发起 Run 动作（运行/停止/审批）后刷新列表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, latestRun?.id])

  const selectRun = async (runId: string): Promise<void> => {
    if (!draft) return
    try {
      const [run, events] = await Promise.all([
        window.electronAPI.getWorkflowRun(draft.id, runId),
        window.electronAPI.listWorkflowRunEvents(draft.id, runId),
      ])
      if (!run) throw new Error('Run 不存在')
      setLatestRun(run)
      setSelectedRunId(runId)
      setRunEvents(events)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取 Run 失败')
    }
  }

  const createNew = (): void => {
    const workspaceId = currentWorkspaceId ?? workspaces[0]?.id
    if (!workspaceId) {
      toast.error('请先在 Agent 模式创建一个工作区')
      return
    }
    const next = createWorkflow(workspaceId)
    setDraft(next)
    setSelectedId(next.id)
    setActiveView('workflow')
  }

  const selectDefinition = async (id: string): Promise<void> => {
    setActiveView('workflow')
    try {
      const definition = await window.electronAPI.getWorkflowDefinition(id)
      if (!definition) throw new Error('Workflow 不存在')
      setSelectedId(id)
      setDraft(definition)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取 Workflow 失败')
    }
  }

  const importFile = async (): Promise<void> => {
    const workspaceId = currentWorkspaceId ?? workspaces[0]?.id
    if (!workspaceId) { toast.error('请先选择目标工作区'); return }
    try {
      const imported = await window.electronAPI.importWorkflowDefinitionFile(workspaceId)
      if (!imported) return
      setDraft(imported); setSelectedId(imported.id); setDefinitions((items) => [imported, ...items.filter((item) => item.id !== imported.id)])
      setActiveView('workflow')
      toast.success('已导入为目标工作区的独立草稿')
    } catch (error) { toast.error(error instanceof Error ? error.message : '导入失败') }
  }

  const installTemplate = async (template: WorkflowTemplate): Promise<void> => {
    const workspaceId = currentWorkspaceId ?? workspaces[0]?.id
    if (!workspaceId) { toast.error('请先选择目标工作区'); return }
    try {
      const installed = await window.electronAPI.installWorkflowTemplate({ templateId: template.id, workspaceId })
      setDraft(installed); setSelectedId(installed.id); setDefinitions((items) => [installed, ...items])
      setActiveView('workflow')
      toast.success('模板已安装为独立草稿')
    } catch (error) { toast.error(error instanceof Error ? error.message : '模板安装失败') }
  }

  const deleteTemplate = async (template: WorkflowTemplate): Promise<void> => {
    try {
      await window.electronAPI.deleteWorkflowTemplate(template.id)
      setTemplates((items) => items.filter((item) => item.id !== template.id))
      toast.success('模板已删除')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '模板删除失败')
    }
  }

  const deleteDefinition = async (definition: WorkflowDefinition): Promise<void> => {
    const confirmed = window.confirm(`确定删除 Workflow「${definition.name}」吗？\n将同时删除其全部 Run 快照与审计事件，此操作不可恢复。`)
    if (!confirmed) return
    try {
      const result = await window.electronAPI.deleteWorkflowDefinition(definition.id)
      if (!result.deleted) {
        toast.error(result.reason ?? 'Workflow 删除失败')
        return
      }
      setDefinitions((items) => items.filter((item) => item.id !== definition.id))
      if (selectedId === definition.id) {
        setSelectedId(null)
        setDraft(null)
      }
      toast.success('Workflow 已删除')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Workflow 删除失败')
    }
  }

  return (
    <div className="flex flex-col gap-3 min-h-0 flex-1 overflow-hidden">
      {/* 标题 + 导入/新建 */}
      <div className="flex items-center justify-between px-2">
        <div>
          <div className="text-sm font-semibold">Workflow</div>
          <div className="text-xs text-muted-foreground">定义、发布与运行</div>
        </div>
        <div className="flex gap-1">
          <Button size="icon-sm" variant="secondary" onClick={() => void importFile()} title="导入 Workflow"><Upload /></Button>
          <Button size="icon-sm" variant="secondary" onClick={createNew} title="新建 Workflow"><Plus /></Button>
        </div>
      </div>

      {/* 本地模板 */}
      <div className="flex-shrink-0">
        <div className="px-1 pb-1 text-xs font-medium text-muted-foreground">本地模板</div>
        <div className="max-h-32 space-y-1 overflow-y-auto">
          {templates.length === 0
            ? <div className="px-1 text-[11px] text-muted-foreground">暂无模板</div>
            : templates.map((template) => (
                <div key={template.id} className="group flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-muted">
                  <button type="button" onClick={() => void installTemplate(template)} className="min-w-0 flex-1 text-left text-xs">
                    <div className="truncate">{template.name}</div>
                    <div className="text-[10px] text-muted-foreground">v{template.version} · 点击安装</div>
                  </button>
                  <button type="button" onClick={() => void deleteTemplate(template)} className="shrink-0 p-1 text-muted-foreground/50 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" title="删除模板"><X size={12} /></button>
                </div>
              ))}
        </div>
      </div>

      {/* 我的 Workflow 列表 */}
      <div className="flex-1 min-h-0 space-y-1 overflow-y-auto">
        {loading && <div className="text-xs text-muted-foreground px-2">正在读取…</div>}
        {definitions.map((definition) => (
          <div key={definition.id} className="group flex items-center gap-1 rounded-lg hover:bg-muted/70 transition-colors">
            <button onClick={() => void selectDefinition(definition.id)} className={cn('min-w-0 flex-1 rounded-lg px-2.5 py-2 text-left transition-colors', selectedId === definition.id ? 'bg-primary/10' : '')}>
              <div className="truncate text-sm font-medium">{definition.name}</div>
              <div className="text-[11px] text-muted-foreground">{definition.status} · v{definition.version}</div>
            </button>
            <button type="button" onClick={() => void deleteDefinition(definition)} className="shrink-0 p-1 mr-1 text-muted-foreground/50 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" title="删除 Workflow"><X size={12} /></button>
          </div>
        ))}
      </div>

      {/* 运行历史 */}
      <div className="flex-shrink-0">
        <div className="px-1 pb-1 text-xs font-medium text-muted-foreground">运行历史</div>
        <div className="max-h-40 space-y-1 overflow-y-auto">
          {runs.length === 0
            ? <div className="px-1 text-[11px] text-muted-foreground">尚无 Run</div>
            : runs.map((run) => (
                <button key={run.id} type="button" onClick={() => void selectRun(run.id)} className={cn('w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted', selectedRunId === run.id && 'bg-primary/10')}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{run.id.slice(0, 8)}</span>
                    <span>{run.status}</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">{new Date(run.updatedAt).toLocaleString()}</div>
                </button>
              ))}
        </div>
      </div>

      {/* Run 审计事件（跟随所选 Run） */}
      {selectedRunId && (
        <div className="flex-shrink-0 rounded-md border border-border/60 p-2 text-[11px]">
          <div className="mb-1 font-medium">Run 审计事件</div>
          {runEvents.length === 0
            ? <span className="text-muted-foreground">暂无事件</span>
            : <div className="max-h-24 space-y-1 overflow-y-auto text-muted-foreground">
                {runEvents.map((event) => (
                  <div key={event.id}>{new Date(event.occurredAt).toLocaleTimeString()} · {event.type}{event.nodeId ? ` · ${event.nodeId}` : ''}</div>
                ))}
              </div>}
        </div>
      )}

      {/* 底部提示 */}
      <div className="mt-auto rounded-lg bg-muted/60 p-2 text-[11px] leading-5 text-muted-foreground">
        发布会重新校验节点引用的 MCP、Skill 与权限档案；凭证不写入 Workflow 文件。
      </div>
    </div>
  )
}
