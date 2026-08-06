import * as React from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface CollaborateDelegationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 提交并行创建协作子会话；返回后由父组件处理成功/失败 */
  onSubmit: (tasks: Array<{ title?: string; task: string }>) => Promise<void>
}

/**
 * 「并行协作子任务」弹窗
 *
 * 用户在一个多行文本框内一行填写一个子任务；提交后为每个子任务创建一个
 * parallel 的协作子 Agent 会话（侧栏父子树面板随之显示可追踪、可折叠的子任务树）。
 */
export function CollaborateDelegationDialog({
  open,
  onOpenChange,
  onSubmit,
}: CollaborateDelegationDialogProps): React.ReactElement {
  const [text, setText] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  const tasks = React.useMemo(() => {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        // 支持「标题 | 任务」或纯任务一行
        const sep = line.indexOf('|')
        if (sep > 0 && sep < line.length - 1) {
          const title = line.slice(0, sep).trim()
          const task = line.slice(sep + 1).trim()
          return { title, task }
        }
        return { task: line }
      })
  }, [text])

  const handleSubmit = async (): Promise<void> => {
    if (tasks.length === 0 || submitting) return
    setSubmitting(true)
    try {
      await onSubmit(tasks)
      setText('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!submitting) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            并行协作子任务
          </DialogTitle>
          <DialogDescription>
            每行填写一个子任务，将并行创建对应数量的协作子 Agent 会话（左侧栏对应项目下会显示可追踪的子任务树）。
            可用「标题 | 任务」格式给子会话命名。
          </DialogDescription>
        </DialogHeader>

        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'每个子任务一行，例如：\n探索当前项目的目录结构\n调研最新的 Agent 框架 | 输出 3 个候选方案\n审查 core 模块的代码质量'}
          rows={8}
          className="font-mono text-[12px]"
        />

        <div className="text-[11px] text-foreground/50">
          将创建 <span className="font-medium text-primary tabular-nums">{tasks.length}</span> 个并行协作子会话
        </div>

        <DialogFooter>
          <Button variant="ghost" disabled={submitting} onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={tasks.length === 0 || submitting} onClick={() => void handleSubmit()}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            创建并并行执行
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
