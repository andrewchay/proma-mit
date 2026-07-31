/**
 * SaveAsWorkflowButton — 把当前 Agent 会话保存为 Workflow 草稿（P0-4）。
 *
 * 出现在 Agent 成功完成的 turn 操作栏，点击后：
 * 1. 用当前会话标题创建 Workflow 草稿（name / description）
 * 2. 保存到 workflow 存储（draft 状态）
 * 3. 通知用户并可跳转到 Workflow 工作台
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { toast } from 'sonner'
import { Workflow, Loader2 } from 'lucide-react'
import { MessageAction } from '@/components/ai-elements/message'
import { activeViewAtom } from '@/atoms/active-view'
import { WORKFLOW_FORMAT, type WorkflowDefinition } from '@proma/shared'

interface SaveAsWorkflowButtonProps {
  /** 当前会话 ID */
  sessionId: string
  /** 会话标题 */
  sessionTitle: string
  /** 会话所属工作区 ID */
  workspaceId?: string
}

export function SaveAsWorkflowButton({ sessionId, sessionTitle, workspaceId }: SaveAsWorkflowButtonProps): React.ReactElement {
  const store = useStore()
  const [saving, setSaving] = React.useState(false)

  const handleSave = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      // 从会话标题派生出可读的 Workflow 名称
      const name = (sessionTitle || '新工作流').slice(0, 30)

      // 构造一个最小 Workflow 草稿（Agent 节点承载会话提示）
      const now = Date.now()
      const draft: WorkflowDefinition = {
        format: WORKFLOW_FORMAT,
        formatVersion: '1.0',
        id: `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        workspaceId: workspaceId ?? '',
        name,
        description: `从 Agent 会话「${sessionTitle || sessionId.slice(0, 8)}」保存的工作流草稿`,
        status: 'draft',
        version: '0.1.0',
        trigger: { kind: 'manual' },
        nodes: [
          { id: 'start', kind: 'start', title: '开始' },
          { id: 'agent', kind: 'agent', title: name, config: { prompt: '请描述要执行的任务' } },
          { id: 'end', kind: 'end', title: '结束' },
        ],
        edges: [
          { id: 'start-agent', from: 'start', to: 'agent' },
          { id: 'agent-end', from: 'agent', to: 'end' },
        ],
        layout: {
          nodes: {
            start: { x: 0, y: 0 },
            agent: { x: 160, y: 0 },
            end: { x: 320, y: 0 },
          },
        },
        createdAt: now,
        updatedAt: now,
      }

      await window.electronAPI.saveWorkflowDefinition(draft)
      toast.success('已保存为 Workflow 草稿', {
        description: `「${name}」已创建，可在 Workflow 工作台继续编辑`,
        action: {
          label: '打开工作台',
          onClick: () => {
            // 切换到 Workflow 视图
            store.set(activeViewAtom, 'workflow')
          },
        },
      })
    } catch (error) {
      console.error('[保存为工作流] 失败:', error)
      toast.error('保存 Workflow 草稿失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <MessageAction tooltip="保存为 Workflow 草稿" onClick={() => void handleSave()}>
      {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Workflow className="size-3.5" />}
    </MessageAction>
  )
}
