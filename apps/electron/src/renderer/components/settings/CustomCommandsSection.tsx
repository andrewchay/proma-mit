/**
 * CustomCommandsSection — 自定义斜杠命令管理
 *
 * 用户可把自己的高频提示词保存为 `/` 命令：
 * - 在 Agent 输入框输入 `/` 打开命令菜单，选择后提示词填入输入框
 * - 支持新增、编辑、删除，持久化到 settings.json 的 agentCustomCommands
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Pencil, Plus, Trash2, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { agentCustomCommandsAtom } from '@/atoms/shortcut-atoms'
import type { AgentCustomCommand } from '@/types/settings'
import {
  removeCustomCommand,
  replaceCustomCommand,
  validateCustomCommand,
} from './custom-commands-model'

/** 持久化并同步 atom；失败时回滚 */
async function persistCommands(next: AgentCustomCommand[], rollback: AgentCustomCommand[]): Promise<boolean> {
  try {
    await window.electronAPI.updateSettings({ agentCustomCommands: next })
    return true
  } catch (error) {
    console.error('[CustomCommands] 保存失败:', error)
    toast.error('自定义命令保存失败', { id: 'custom-commands-save-error' })
    return false
  }
}

export function CustomCommandsSection(): React.ReactElement {
  const [commands, setCommands] = useAtom(agentCustomCommandsAtom)
  const [editingName, setEditingName] = React.useState<string | null>(null)
  const [name, setName] = React.useState('')
  const [prompt, setPrompt] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)

  const startAdd = (): void => {
    setEditingName(null)
    setName('')
    setPrompt('')
    setError(null)
  }

  const startEdit = (command: AgentCustomCommand): void => {
    setEditingName(command.name)
    setName(command.name)
    setPrompt(command.prompt)
    setError(null)
  }

  const handleSave = async (): Promise<void> => {
    const result = validateCustomCommand({ name, prompt }, commands, editingName ?? undefined)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const previous = commands
    const next = editingName
      ? replaceCustomCommand(commands, editingName, result.command)
      : [...commands, result.command]
    setCommands(next)
    const ok = await persistCommands(next, previous)
    if (ok) {
      toast.success(editingName ? '命令已更新' : '命令已添加', { id: 'custom-commands-save-success' })
      startAdd()
    } else {
      setCommands(previous)
    }
  }

  const handleDelete = async (commandName: string): Promise<void> => {
    const previous = commands
    const next = removeCustomCommand(commands, commandName)
    setCommands(next)
    const ok = await persistCommands(next, previous)
    if (ok) {
      toast.success(`命令 /${commandName} 已删除`, { id: 'custom-commands-delete-success' })
      if (editingName === commandName) startAdd()
    } else {
      setCommands(previous)
    }
  }

  const isEditing = editingName !== null

  return (
    <div>
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
        自定义斜杠命令
      </h3>
      <p className="text-xs text-muted-foreground mb-3">
        在 Agent 输入框输入 <code className="font-mono">/</code> 打开命令菜单即可选用；选择后提示词填入输入框，确认后再发送。
      </p>

      {/* 已有命令列表 */}
      {commands.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {commands.map((command) => (
            <div
              key={command.name}
              className="group flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2"
            >
              <Zap className="size-3.5 shrink-0 text-primary/60" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">/{command.name}</div>
                <div className="text-xs text-muted-foreground truncate">{command.prompt}</div>
              </div>
              <button
                type="button"
                className="shrink-0 rounded-md p-1 text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors"
                title="编辑命令"
                onClick={() => startEdit(command)}
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                type="button"
                className="shrink-0 rounded-md p-1 text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 transition-colors"
                title="删除命令"
                onClick={() => void handleDelete(command.name)}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 新增 / 编辑表单 */}
      <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground shrink-0">/</span>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null) }}
            placeholder="命令名（如 review）"
            className="flex-1 min-w-0 h-8 rounded-md border border-border/60 bg-background px-2 text-sm outline-none focus:border-primary/50"
          />
        </div>
        <textarea
          value={prompt}
          onChange={(e) => { setPrompt(e.target.value); setError(null) }}
          placeholder="提示词内容（选择该命令后填入输入框的完整文本）"
          rows={3}
          className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm outline-none focus:border-primary/50 resize-y"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" className="h-7 text-xs" onClick={() => void handleSave()}>
            <Plus className="size-3 mr-1" />
            {isEditing ? '保存修改' : '添加命令'}
          </Button>
          {isEditing && (
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={startAdd}>
              取消编辑
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
