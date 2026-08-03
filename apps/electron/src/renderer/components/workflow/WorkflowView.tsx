/**
 * Workflow 工作台。
 *
 * 画布位置只是 Definition.layout；节点、连接和能力配置仍以同一份 DSL Draft 为准。
 * 这使拖拽、右侧编辑和后续的对话式 patch 能安全地汇聚到一个存储模型。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  Bot, CheckCircle2, CirclePlay, Download, GitBranch, Hand, LayoutTemplate, Plus, RefreshCcw, RotateCcw, Save, Send, Sparkles, Upload, Wrench, X,
} from 'lucide-react'
import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowTemplate,
} from '@proma/shared'
import { applyWorkflowPatches } from '@proma/shared/workflow'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { agentChannelIdAtom, agentModelIdAtom, agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import {
  selectedWorkflowIdAtom,
  workflowDefinitionsAtom,
  workflowDraftAtom,
  workflowLoadingAtom,
  workflowSavingAtom,
  workflowPatchProposalAtom,
  workflowLatestRunAtom,
  workflowRunsAtom,
  selectedWorkflowRunIdAtom,
  workflowRunEventsAtom,
} from '@/atoms/workflow-atoms'

type PaletteKind = Exclude<WorkflowNodeKind, 'start' | 'end'>

const PALETTE: Array<{ kind: PaletteKind; label: string; icon: React.ReactNode }> = [
  { kind: 'agent', label: 'Agent', icon: <Bot size={15} /> },
  { kind: 'skill', label: 'Skill', icon: <Sparkles size={15} /> },
  { kind: 'tool', label: '工具', icon: <Wrench size={15} /> },
  { kind: 'condition', label: '条件', icon: <GitBranch size={15} /> },
  { kind: 'approval', label: '审批', icon: <Hand size={15} /> },
  { kind: 'transform', label: '映射', icon: <Send size={15} /> },
]

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

function defaultNode(kind: PaletteKind, position: { x: number; y: number }): WorkflowNode {
  const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`
  const base = { id, kind, title: PALETTE.find((item) => item.kind === kind)?.label ?? kind }
  switch (kind) {
    case 'agent': return { ...base, config: { prompt: '完成此步骤并输出可复用的结果。' }, capabilityPolicy: { permissionProfileId: 'workflow-supervised' } }
    case 'skill': return { ...base, config: { skill: { slug: 'replace-with-skill' }, prompt: '按照 Skill 执行此步骤。' }, capabilityPolicy: { skills: [{ slug: 'replace-with-skill' }], permissionProfileId: 'workflow-supervised' } }
    case 'tool': return { ...base, config: { toolName: 'replace-with-tool' }, capabilityPolicy: { allowedTools: ['replace-with-tool'], permissionProfileId: 'workflow-supervised' } }
    case 'condition': return { ...base, config: { expression: '$input.approved === true' } }
    case 'approval': return { ...base, config: { assigneePolicy: 'workflow_owner', onTimeout: 'fail' } }
    case 'transform': return { ...base, config: { assignments: {} } }
  }
}

function nodeColor(kind: WorkflowNodeKind): string {
  if (kind === 'start' || kind === 'end') return 'bg-emerald-500/15 border-emerald-500/35 text-emerald-900 dark:text-emerald-100'
  if (kind === 'approval') return 'bg-amber-500/15 border-amber-500/35 text-amber-900 dark:text-amber-100'
  if (kind === 'condition') return 'bg-violet-500/15 border-violet-500/35 text-violet-900 dark:text-violet-100'
  return 'bg-sky-500/15 border-sky-500/35 text-sky-900 dark:text-sky-100'
}

function replaceNode(draft: WorkflowDefinition, node: WorkflowNode): WorkflowDefinition {
  return { ...draft, nodes: draft.nodes.map((item) => item.id === node.id ? node : item), updatedAt: Date.now() }
}

export function WorkflowView(): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const [definitions, setDefinitions] = useAtom(workflowDefinitionsAtom)
  const [selectedId, setSelectedId] = useAtom(selectedWorkflowIdAtom)
  const [draft, setDraft] = useAtom(workflowDraftAtom)
  const [loading, setLoading] = useAtom(workflowLoadingAtom)
  const [saving, setSaving] = useAtom(workflowSavingAtom)
  const [proposal, setProposal] = useAtom(workflowPatchProposalAtom)
  const [latestRun, setLatestRun] = useAtom(workflowLatestRunAtom)
  const [runs, setRuns] = useAtom(workflowRunsAtom)
  const [selectedRunId, setSelectedRunId] = useAtom(selectedWorkflowRunIdAtom)
  const [runEvents, setRunEvents] = useAtom(workflowRunEventsAtom)
  const agentChannelId = useAtomValue(agentChannelIdAtom)
  const agentModelId = useAtomValue(agentModelIdAtom)
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null)
  const [intent, setIntent] = React.useState('')
  const [templates, setTemplates] = React.useState<WorkflowTemplate[]>([])
  const [templateUpgradePending, setTemplateUpgradePending] = React.useState(false)

  const loadTemplates = React.useCallback(async () => {
    try { setTemplates(await window.electronAPI.listWorkflowTemplates()) } catch { /* 模板失败不阻断编辑器 */ }
  }, [])

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
  }, [draft?.id, loadRunHistory, setRunEvents, setRuns])

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

  const addNode = React.useCallback((kind: PaletteKind, position: { x: number; y: number }) => {
    if (!draft) return
    const node = defaultNode(kind, position)
    const endEdge = draft.edges.find((edge) => edge.to === 'end')
    const edges = endEdge && kind === 'condition'
      ? [
          ...draft.edges.filter((edge) => edge.id !== endEdge.id),
          { id: `${endEdge.from}-to-${node.id}`, from: endEdge.from, to: node.id },
          { id: `${node.id}-true-end`, from: node.id, to: 'end', label: 'true' },
          { id: `${node.id}-false-end`, from: node.id, to: 'end', label: 'false' },
        ]
      : endEdge
      ? [
          ...draft.edges.filter((edge) => edge.id !== endEdge.id),
          { id: `${endEdge.from}-to-${node.id}`, from: endEdge.from, to: node.id },
          { id: `${node.id}-to-end`, from: node.id, to: 'end' },
        ]
      : draft.edges
    setDraft({
      ...draft,
      nodes: [...draft.nodes, node],
      edges,
      layout: { ...draft.layout, nodes: { ...draft.layout.nodes, [node.id]: position } },
      updatedAt: Date.now(),
    })
    setSelectedNodeId(node.id)
  }, [draft, setDraft])

  const removeNode = React.useCallback((nodeId: string) => {
    if (!draft) return
    const node = draft.nodes.find((item) => item.id === nodeId)
    if (!node) return
    if (node.kind === 'start' || node.kind === 'end') {
      toast.error('开始/结束节点不可删除')
      return
    }
    const nextNodes = draft.nodes.filter((item) => item.id !== nodeId)
    const nextEdges = draft.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId)
    const nextLayoutNodes = { ...draft.layout.nodes }
    delete nextLayoutNodes[nodeId]
    setDraft({
      ...draft,
      nodes: nextNodes,
      edges: nextEdges,
      layout: { ...draft.layout, nodes: nextLayoutNodes },
      updatedAt: Date.now(),
    })
    if (selectedNodeId === nodeId) setSelectedNodeId(null)
  }, [draft, setDraft, selectedNodeId])

  const createNew = (): void => {
    const workspaceId = currentWorkspaceId ?? workspaces[0]?.id
    if (!workspaceId) {
      toast.error('请先在 Agent 模式创建一个工作区')
      return
    }
    const next = createWorkflow(workspaceId)
    setDraft(next)
    setSelectedId(next.id)
    setSelectedNodeId(null)
    setProposal(null)
  }

  const selectDefinition = async (id: string): Promise<void> => {
    try {
      const definition = await window.electronAPI.getWorkflowDefinition(id)
      if (!definition) throw new Error('Workflow 不存在')
      setSelectedId(id)
      setDraft(definition)
      setSelectedNodeId(null)
      setProposal(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取 Workflow 失败')
    }
  }

  const save = async (): Promise<boolean> => {
    if (!draft) return false
    setSaving(true)
    try {
      const saved = await window.electronAPI.saveWorkflowDefinition(draft)
      setDraft(saved)
      setDefinitions((previous) => [saved, ...previous.filter((item) => item.id !== saved.id)])
      toast.success('Workflow 草稿已保存')
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败，请检查节点配置')
      return false
    } finally {
      setSaving(false)
    }
  }

  const publish = async (): Promise<void> => {
    if (!draft) return
    if (!await save()) return
    try {
      const published = await window.electronAPI.publishWorkflowDefinition(draft.id, { version: draft.version })
      setDraft(published)
      setDefinitions((previous) => [published, ...previous.filter((item) => item.id !== published.id)])
      toast.success('Workflow 已发布')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '发布前校验失败')
    }
  }

  const exportFile = async (): Promise<void> => {
    if (!draft) return
    try { if (await window.electronAPI.exportWorkflowDefinitionFile(draft.id)) toast.success('Workflow 文件已导出') } catch (error) { toast.error(error instanceof Error ? error.message : '导出失败') }
  }

  const importFile = async (): Promise<void> => {
    const workspaceId = currentWorkspaceId ?? workspaces[0]?.id
    if (!workspaceId) { toast.error('请先选择目标工作区'); return }
    try {
      const imported = await window.electronAPI.importWorkflowDefinitionFile(workspaceId)
      if (!imported) return
      setDraft(imported); setSelectedId(imported.id); setDefinitions((items) => [imported, ...items.filter((item) => item.id !== imported.id)])
      toast.success('已导入为目标工作区的独立草稿')
    } catch (error) { toast.error(error instanceof Error ? error.message : '导入失败') }
  }

  const publishTemplate = async (): Promise<void> => {
    if (!draft) return
    if (draft.status !== 'published') { toast.error('请先发布 Workflow，再发布为模板'); return }
    try { await window.electronAPI.publishWorkflowTemplate(draft.id, { templateId: `template-${draft.id}`, name: draft.name, description: draft.description, version: draft.version }); await loadTemplates(); toast.success('已发布到本地模板库') } catch (error) { toast.error(error instanceof Error ? error.message : '模板发布失败') }
  }

  const installTemplate = async (template: WorkflowTemplate): Promise<void> => {
    const workspaceId = currentWorkspaceId ?? workspaces[0]?.id
    if (!workspaceId) { toast.error('请先选择目标工作区'); return }
    try { const installed = await window.electronAPI.installWorkflowTemplate({ templateId: template.id, workspaceId }); setDraft(installed); setSelectedId(installed.id); setDefinitions((items) => [installed, ...items]); toast.success('模板已安装为独立草稿') } catch (error) { toast.error(error instanceof Error ? error.message : '模板安装失败') }
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

  const upgradeTemplate = async (): Promise<void> => { if (!draft) return; try { if (!templateUpgradePending) { const preview = await window.electronAPI.previewWorkflowTemplateUpgrade(draft.id); setTemplateUpgradePending(true); toast.message(`已生成升级差异：新增 ${preview.diff.addedNodeIds.length}、删除 ${preview.diff.removedNodeIds.length}、修改 ${preview.diff.changedNodeIds.length} 个节点；再次点击确认升级`); return } const next = await window.electronAPI.upgradeWorkflowTemplate(draft.id); setDraft(next); setTemplateUpgradePending(false); toast.success('已升级模板安装副本') } catch (error) { setTemplateUpgradePending(false); toast.error(error instanceof Error ? error.message : '没有可用升级') } }
  const rollbackTemplate = async (): Promise<void> => { if (!draft) return; try { const next = await window.electronAPI.rollbackWorkflowTemplate(draft.id); setDraft(next); toast.success('已回滚模板安装副本') } catch (error) { toast.error(error instanceof Error ? error.message : '没有可回滚版本') } }

  const proposeIntent = async (): Promise<void> => {
    const value = intent.trim()
    if (!value || !draft) return
    if (!agentChannelId) {
      toast.error('请先在 Agent 模式选择一个渠道，再使用对话式配置')
      return
    }
    try {
      const next = await window.electronAPI.proposeWorkflowPatches({ definition: draft, instruction: value, channelId: agentChannelId, ...(agentModelId ? { modelId: agentModelId } : {}) })
      setProposal(next)
      setIntent('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Workflow 设计器调用失败')
    }
  }

  const applyProposal = (): void => {
    if (!draft || !proposal) return
    try {
      setDraft(applyWorkflowPatches(draft, proposal.patches))
      toast.success('已应用经过 DSL 校验的设计建议')
      setProposal(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '建议无法应用到当前 Draft')
    }
  }

  const runWorkflow = async (): Promise<void> => {
    if (!draft) return
    if (!agentChannelId) {
      toast.error('请先在 Agent 模式选择一个渠道，再执行 Workflow')
      return
    }
    if (draft.status !== 'published') {
      toast.error('请先发布 Workflow，再创建可审计的 Run')
      return
    }
    try {
      const run = await window.electronAPI.createWorkflowRun(draft.id, {})
      const progressed = await window.electronAPI.executeWorkflowRun({ workflowId: draft.id, runId: run.id, channelId: agentChannelId, ...(agentModelId ? { modelId: agentModelId } : {}) })
      setLatestRun(progressed)
      await loadRunHistory(draft.id, progressed.id)
      toast.success(progressed.status === 'waiting_approval' ? 'Run 已暂停，等待审批' : `Run 状态：${progressed.status}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '执行 Workflow 失败')
    }
  }

  const resolveLatestApproval = async (approved: boolean): Promise<void> => {
    if (!draft || !latestRun || !agentChannelId) return
    const approval = latestRun.approvals.find((item) => item.status === 'pending')
    if (!approval) return
    try {
      const resolved = await window.electronAPI.resolveWorkflowApproval({ workflowId: draft.id, runId: latestRun.id, approvalId: approval.id, decision: { approved, resolvedBy: 'local-user' } })
      const progressed = approved
        ? await window.electronAPI.executeWorkflowRun({ workflowId: draft.id, runId: resolved.id, channelId: agentChannelId, ...(agentModelId ? { modelId: agentModelId } : {}) })
        : resolved
      setLatestRun(progressed)
      await loadRunHistory(draft.id, progressed.id)
      toast.success(approved ? `审批通过，Run 状态：${progressed.status}` : '审批已拒绝')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '处理审批失败')
    }
  }

  const selectedNode = draft?.nodes.find((node) => node.id === selectedNodeId) ?? null

  return (
    <div className="flex h-full min-h-0 titlebar-no-drag">
      <aside className="w-56 shrink-0 border-r border-border/60 bg-background/50 p-3 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div><div className="text-sm font-semibold">Workflow</div><div className="text-xs text-muted-foreground">定义、发布与运行</div></div>
          <div className="flex gap-1"><Button size="icon-sm" variant="secondary" onClick={() => void importFile()} title="导入 Workflow"><Upload /></Button><Button size="icon-sm" variant="secondary" onClick={createNew} title="新建 Workflow"><Plus /></Button></div>
        </div>
        <div className="border-t border-border/60 pt-2"><div className="px-1 pb-1 text-xs font-medium text-muted-foreground">本地模板</div><div className="max-h-32 space-y-1 overflow-y-auto">{templates.length === 0 ? <div className="px-1 text-[11px] text-muted-foreground">暂无模板</div> : templates.map((template) => <div key={template.id} className="group flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-muted"><button type="button" onClick={() => void installTemplate(template)} className="min-w-0 flex-1 text-left text-xs"><div className="truncate">{template.name}</div><div className="text-[10px] text-muted-foreground">v{template.version} · 点击安装</div></button><button type="button" onClick={() => void deleteTemplate(template)} className="shrink-0 p-1 text-muted-foreground/50 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" title="删除模板"><X size={12} /></button></div>)}</div></div>
        <div className="space-y-1 overflow-y-auto">
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
        {draft && <div className="border-t border-border/60 pt-2"><div className="px-1 pb-1 text-xs font-medium text-muted-foreground">运行历史</div><div className="max-h-36 space-y-1 overflow-y-auto">{runs.length === 0 ? <div className="px-1 text-[11px] text-muted-foreground">尚无 Run</div> : runs.map((run) => <button key={run.id} type="button" onClick={() => void selectRun(run.id)} className={cn('w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted', selectedRunId === run.id && 'bg-primary/10')}><div className="flex items-center justify-between gap-2"><span className="truncate">{run.id.slice(0, 8)}</span><span>{run.status}</span></div><div className="mt-0.5 text-[10px] text-muted-foreground">{new Date(run.updatedAt).toLocaleString()}</div></button>)}</div></div>}
        <div className="mt-auto rounded-lg bg-muted/60 p-2 text-[11px] leading-5 text-muted-foreground">发布会重新校验节点引用的 MCP、Skill 与权限档案；凭证不写入 Workflow 文件。</div>
      </aside>

      {!draft ? (
        <div className="flex-1 grid place-items-center text-center"><div><CirclePlay className="mx-auto mb-3 text-muted-foreground" /><p className="font-medium">创建一个 Workflow 开始</p><p className="text-sm text-muted-foreground mt-1">画布、表单和后续聊天配置会编辑同一份 Definition。</p></div></div>
      ) : (
        <>
          <main className="min-w-0 flex-1 flex flex-col">
            <header className="flex items-center gap-2 border-b border-border/60 bg-background/65 px-4 py-2.5">
              <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value, updatedAt: Date.now() })} className="max-w-sm border-0 bg-transparent text-base font-semibold shadow-none" aria-label="Workflow 名称" />
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{draft.status} · v{draft.version}</span>
              <div className="ml-auto flex gap-2">{latestRun && <span className="self-center text-xs text-muted-foreground">最近 Run：{latestRun.status}</span>}<Button size="sm" variant="ghost" onClick={() => void exportFile()}><Download />导出</Button><Button size="sm" variant="ghost" onClick={() => void publishTemplate()}><LayoutTemplate />模板</Button><Button size="sm" variant={templateUpgradePending ? 'default' : 'ghost'} onClick={() => void upgradeTemplate()}><RefreshCcw />{templateUpgradePending ? '确认升级' : '升级'}</Button><Button size="sm" variant="ghost" onClick={() => void rollbackTemplate()}><RotateCcw />回滚</Button><Button size="sm" variant="secondary" onClick={() => void save()} disabled={saving}><Save />保存</Button><Button size="sm" onClick={() => void publish()} disabled={saving}><CheckCircle2 />发布</Button><Button size="sm" variant="outline" onClick={() => void runWorkflow()}><CirclePlay />运行</Button></div>
            </header>
            <div className="flex min-h-0 flex-1">
              <section className="w-32 shrink-0 border-r border-border/60 bg-background/35 p-2"><div className="mb-2 px-1 text-xs font-medium text-muted-foreground">拖入节点</div>{PALETTE.map((item) => <button key={item.kind} draggable onDragStart={(event) => event.dataTransfer.setData('application/paa-workflow-node', item.kind)} className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs hover:bg-muted" type="button">{item.icon}{item.label}</button>)}</section>
              <WorkflowCanvas draft={draft} selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} onRemoveNode={removeNode} onMove={(nodeId, position) => setDraft({ ...draft, layout: { ...draft.layout, nodes: { ...draft.layout.nodes, [nodeId]: position } }, updatedAt: Date.now() })} onDropNode={addNode} />
            </div>
            <div className="border-t border-border/60 bg-background/70 p-3"><div className="flex gap-2"><Textarea value={intent} onChange={(event) => setIntent(event.target.value)} placeholder="用自然语言补充步骤，例如：添加人工审批，确认预算后再继续" className="min-h-9 h-9 resize-none py-2" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void proposeIntent() } }} /><Button onClick={() => void proposeIntent()} title="生成受校验的 Workflow patch"><Send />建议</Button></div>{proposal ? <div className="mt-2 rounded-md bg-primary/8 p-2 text-xs"><p className="leading-5">{proposal.reply}</p><div className="mt-2 rounded border border-primary/20 bg-background/60 p-2"><div className="mb-1 font-medium">建议差异（尚未写入）</div>{proposal.patches.map((patch, index) => <div key={index} className="font-mono text-[11px] leading-5">{JSON.stringify(patch)}</div>)}</div><div className="mt-2 flex items-center gap-2"><Button size="sm" onClick={applyProposal}>确认并应用 {proposal.patches.length} 个建议</Button><Button size="sm" variant="ghost" onClick={() => setProposal(null)}>忽略</Button></div></div> : <p className="mt-1 text-[11px] text-muted-foreground">设计器只返回受限 patch；你预览并确认后才会修改 Draft，更不会直接写入文件。</p>}{latestRun?.status === 'waiting_approval' && <div className="mt-2 flex items-center justify-between rounded-md bg-amber-500/10 px-3 py-2 text-xs"><span>Run 正在等待已冻结的审批主体；当前工作台以 local-user 决策。</span><div className="flex gap-1"><Button size="sm" onClick={() => void resolveLatestApproval(true)}>通过</Button><Button size="sm" variant="outline" onClick={() => void resolveLatestApproval(false)}>拒绝</Button></div></div>}{selectedRunId && <div className="mt-2 rounded-md border border-border/60 p-2 text-[11px]"><div className="mb-1 font-medium">Run 审计事件</div>{runEvents.length === 0 ? <span className="text-muted-foreground">暂无事件</span> : <div className="max-h-20 space-y-1 overflow-y-auto text-muted-foreground">{runEvents.map((event) => <div key={event.id}>{new Date(event.occurredAt).toLocaleTimeString()} · {event.type}{event.nodeId ? ` · ${event.nodeId}` : ''}</div>)}</div>}</div>}</div>
          </main>
          <WorkflowInspector
            node={selectedNode}
            nodes={draft.nodes}
            edges={draft.edges}
            onChange={(node) => setDraft(replaceNode(draft, node))}
            onRemoveNode={removeNode}
            onAddEdge={(to, label) => setDraft({ ...draft, edges: [...draft.edges, { id: `edge-${crypto.randomUUID().slice(0, 8)}`, from: selectedNode!.id, to, ...(label ? { label } : {}) }], updatedAt: Date.now() })}
            onRemoveEdge={(edgeId) => setDraft({ ...draft, edges: draft.edges.filter((edge) => edge.id !== edgeId), updatedAt: Date.now() })}
          />
        </>
      )}
    </div>
  )
}

function WorkflowCanvas({ draft, selectedNodeId, onSelect, onRemoveNode, onMove, onDropNode }: { draft: WorkflowDefinition; selectedNodeId: string | null; onSelect: (id: string) => void; onRemoveNode: (id: string) => void; onMove: (id: string, position: { x: number; y: number }) => void; onDropNode: (kind: PaletteKind, position: { x: number; y: number }) => void }): React.ReactElement {
  const canvasRef = React.useRef<HTMLDivElement>(null)
  const dragging = React.useRef<{ id: string; origin: { x: number; y: number }; pointer: { x: number; y: number } } | null>(null)
  React.useEffect(() => {
    const move = (event: PointerEvent) => { const state = dragging.current; if (!state) return; onMove(state.id, { x: Math.max(0, state.origin.x + event.clientX - state.pointer.x), y: Math.max(0, state.origin.y + event.clientY - state.pointer.y) }) }
    const up = () => { dragging.current = null }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [onMove])
  return <div ref={canvasRef} className="relative flex-1 overflow-auto bg-[radial-gradient(hsl(var(--border))_1px,transparent_1px)] bg-[size:18px_18px]" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const kind = event.dataTransfer.getData('application/paa-workflow-node') as PaletteKind; const rect = canvasRef.current?.getBoundingClientRect(); if (kind && rect) onDropNode(kind, { x: event.clientX - rect.left, y: event.clientY - rect.top }) }}>
    <svg className="absolute inset-0 h-full w-full pointer-events-none overflow-visible">{draft.edges.map((edge) => { const from = draft.layout.nodes[edge.from]; const to = draft.layout.nodes[edge.to]; if (!from || !to) return null; return <line key={edge.id} x1={from.x + 130} y1={from.y + 30} x2={to.x} y2={to.y + 30} stroke="currentColor" className="text-border" strokeWidth="2" /> })}</svg>
    {draft.nodes.map((node) => { const position = draft.layout.nodes[node.id] ?? { x: 0, y: 0 }; const isStartEnd = node.kind === 'start' || node.kind === 'end'; return <div key={node.id} className={cn('absolute w-[130px] rounded-xl border px-3 py-2 text-left shadow-sm cursor-grab active:cursor-grabbing group', nodeColor(node.kind), selectedNodeId === node.id && 'ring-2 ring-primary ring-offset-2')} style={{ left: position.x, top: position.y }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); dragging.current = { id: node.id, origin: position, pointer: { x: event.clientX, y: event.clientY } } }} onClick={() => onSelect(node.id)}><div className="flex items-start justify-between gap-1"><div className="text-xs font-semibold truncate">{node.title}</div>{!isStartEnd && <button type="button" onClick={(event) => { event.stopPropagation(); onRemoveNode(node.id) }} className="-mr-1 -mt-1 shrink-0 p-1 text-muted-foreground/50 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" title="删除节点"><X size={12} /></button>}</div><div className="mt-0.5 text-[10px] opacity-70">{node.kind}</div></div> })}
  </div>
}

function WorkflowInspector({ node, nodes, edges, onChange, onRemoveNode, onAddEdge, onRemoveEdge }: { node: WorkflowNode | null; nodes: WorkflowNode[]; edges: WorkflowDefinition['edges']; onChange: (node: WorkflowNode) => void; onRemoveNode: (id: string) => void; onAddEdge: (to: string, label?: string) => void; onRemoveEdge: (edgeId: string) => void }): React.ReactElement {
  const [targetId, setTargetId] = React.useState('')
  const [edgeLabel, setEdgeLabel] = React.useState('')
  if (!node) return <aside className="w-72 shrink-0 border-l border-border/60 bg-background/50 p-4"><div className="text-sm font-medium">节点配置</div><p className="mt-2 text-sm text-muted-foreground">选择画布中的节点，定义它的输入、能力与审批规则。</p></aside>
  const config = node.config as Record<string, unknown> | undefined
  const updateConfig = (key: string, value: unknown) => onChange({ ...node, config: { ...config, [key]: value } } as unknown as WorkflowNode)
  const policy = node.capabilityPolicy ?? {}
  const updatePolicy = (changes: NonNullable<WorkflowNode['capabilityPolicy']>) => onChange({ ...node, capabilityPolicy: changes })
  const parseReferences = (value: string): Array<{ slug: string; version?: string }> => value.split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    const [slug, version] = item.split('@')
    return version ? { slug: slug!, version } : { slug: slug! }
  })
  const prompt = typeof config?.prompt === 'string' ? config.prompt : ''
  const outgoing = edges.filter((edge) => edge.from === node.id)
  const targets = nodes.filter((candidate) => candidate.id !== node.id && !outgoing.some((edge) => edge.to === candidate.id))
  return <aside className="w-72 shrink-0 overflow-y-auto border-l border-border/60 bg-background/50 p-4"><div className="flex items-start justify-between gap-2"><div className="text-xs text-muted-foreground">{node.kind}</div>{node.kind !== 'start' && node.kind !== 'end' && <button type="button" onClick={() => onRemoveNode(node.id)} className="-mr-1 -mt-1 p-1 text-muted-foreground/50 hover:text-destructive" title="删除节点"><X size={14} /></button>}</div><Input className="mt-1 font-medium" value={node.title} onChange={(event) => onChange({ ...node, title: event.target.value })} />
    {(node.kind === 'agent' || node.kind === 'skill') && <><label className="mt-4 block text-xs font-medium">指令</label><Textarea className="mt-1" value={prompt} onChange={(event) => updateConfig('prompt', event.target.value)} /></>}
    {node.kind === 'tool' && <><label className="mt-4 block text-xs font-medium">工具名称</label><Input className="mt-1" value={typeof config?.toolName === 'string' ? config.toolName : ''} onChange={(event) => updateConfig('toolName', event.target.value)} /></>}
    {node.kind === 'condition' && <><label className="mt-4 block text-xs font-medium">表达式</label><Input className="mt-1" value={typeof config?.expression === 'string' ? config.expression : ''} onChange={(event) => updateConfig('expression', event.target.value)} /></>}
    {node.kind === 'approval' && <p className="mt-4 rounded-md bg-amber-500/10 p-2 text-xs leading-5 text-amber-900 dark:text-amber-100">此节点将在运行时暂停，审批人会在创建 Run 时从发布者、命名用户或角色目录解析并冻结。</p>}
    {['agent', 'skill', 'tool'].includes(node.kind) && <div className="mt-5 border-t border-border/60 pt-3"><div className="text-xs font-medium">节点能力（最小权限）</div><label className="mt-2 block text-[11px] text-muted-foreground">允许工具（逗号分隔）</label><Input className="mt-1 h-8 text-xs" value={(policy.allowedTools ?? []).join(', ')} onChange={(event) => updatePolicy({ ...policy, allowedTools: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} placeholder="Read, mcp__server__tool" /><label className="mt-2 block text-[11px] text-muted-foreground">Skills（slug 或 slug@version）</label><Input className="mt-1 h-8 text-xs" value={(policy.skills ?? []).map((item) => `${item.slug}${item.version ? `@${item.version}` : ''}`).join(', ')} onChange={(event) => updatePolicy({ ...policy, skills: parseReferences(event.target.value) })} placeholder="project-review@1.0.0" /><label className="mt-2 block text-[11px] text-muted-foreground">MCP Servers（名称）</label><Input className="mt-1 h-8 text-xs" value={(policy.mcpServers ?? []).map((item) => item.name).join(', ')} onChange={(event) => updatePolicy({ ...policy, mcpServers: event.target.value.split(',').map((item) => item.trim()).filter(Boolean).map((name) => ({ name })) })} placeholder="nocobase" /><label className="mt-2 block text-[11px] text-muted-foreground">权限档案</label><select value={policy.permissionProfileId ?? ''} onChange={(event) => updatePolicy({ ...policy, ...(event.target.value ? { permissionProfileId: event.target.value } : {}) })} className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs"><option value="">未指定</option><option value="workflow-readonly">workflow-readonly</option><option value="workflow-supervised">workflow-supervised</option></select></div>}
    {node.kind !== 'end' && <div className="mt-5 border-t border-border/60 pt-3"><div className="text-xs font-medium">连线</div><div className="mt-2 flex gap-1"><select value={targetId} onChange={(event) => setTargetId(event.target.value)} className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"><option value="">选择目标节点</option>{targets.map((target) => <option key={target.id} value={target.id}>{target.title} · {target.kind}</option>)}</select><Button size="sm" variant="secondary" disabled={!targetId} onClick={() => { onAddEdge(targetId, edgeLabel.trim() || undefined); setTargetId(''); setEdgeLabel('') }}>连接</Button></div>{node.kind === 'condition' || node.onFailure === 'route_to_error' ? <Input className="mt-1 h-8 text-xs" value={edgeLabel} onChange={(event) => setEdgeLabel(event.target.value)} placeholder={node.kind === 'condition' ? '分支标签：true / false' : '错误边标签：error'} /> : null}<div className="mt-2 space-y-1">{outgoing.map((edge) => <div key={edge.id} className="flex items-center justify-between rounded bg-muted/60 px-2 py-1 text-[11px]"><span className="truncate">→ {nodes.find((item) => item.id === edge.to)?.title ?? edge.to}{edge.label ? ` · ${edge.label}` : ''}</span><button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => onRemoveEdge(edge.id)}>删除</button></div>)}</div></div>}
  </aside>
}
