import * as React from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface CollaborateDelegationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 用模型把主任务自动拆成多个并行协作子会话；返回后由父组件处理成功/失败 */
  onSubmit: (mainTask: string) => Promise<void>
}

/**
 * 「并行协作子任务」弹窗
 *
 * 仅需输入一个主任务描述，点击「自动拆分子任务并并行执行」——
 * 后端用模型把主任务拆成多个自包含子任务，再并行创建协作子 Agent 会话，
 * 侧栏父子树面板随之显示可折叠、可追踪的子任务树。
 */
export function CollaborateDelegationDialog({
  open,
  onOpenChange,
  onSubmit,
}: CollaborateDelegationDialogProps): React.ReactElement {
  const [mainTask, setMainTask] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  const handleSubmit = async (): Promise<void> => {
    const trimmed = mainTask.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      await onSubmit(trimmed)
      setMainTask('')
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
            填写一个主任务，点按钮后系统会用模型自动拆分为多个可并行执行的子任务，并创建协作子 Agent 会话。
            左侧栏对应项目下会显示可追踪、可折叠的子任务树。
          </DialogDescription>
        </DialogHeader>

        <Textarea
          value={mainTask}
          onChange={(e) => setMainTask(e.target.value)}
          placeholder={'例如：做原神、铁道、鸣潮三款产品的用研，输出竞品 & 用户洞察对比'}
          rows={4}
          className="text-[13px]"
        />

        <DialogFooter>
          <Button variant="ghost" disabled={submitting} onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={!mainTask.trim() || submitting} onClick={() => void handleSubmit()}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {submitting ? '正在拆分子任务并并行执行…' : '自动拆分子任务并并行执行'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
