import { useState } from 'react'
import { getPerformanceSamples } from '@/lib/performance-monitor'
import { Button } from '@/components/ui/button'

export function PerformanceSettings(): React.ReactElement {
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  async function save(): Promise<void> {
    setSaving(true)
    setMessage('')
    try {
      const result = await window.electronAPI.savePerformanceSnapshot(getPerformanceSamples())
      setMessage(result.saved ? '性能记录已保存。' : '已取消保存。')
    } catch (error) {
      setMessage(`保存失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally { setSaving(false) }
  }
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">卡顿诊断</h2>
      <p className="text-sm text-muted-foreground">遇到输入或流式输出卡顿后，尽快保存最近 30 秒的性能记录。记录包含输入至下一帧的时间、长任务、慢帧、流式状态及进程资源占用，不包含输入内容或对话正文。检测到超过 200 毫秒的渲染长任务或主进程延迟时会自动保存本地记录，最多保留 10 份；手动保存的位置由你选择。</p>
      <Button disabled={saving} onClick={() => void save()}>{saving ? '正在保存…' : '刚才卡了，保存性能记录'}</Button>
      <Button variant="outline" onClick={() => { void window.electronAPI.openPerformanceDiagnostics().catch(() => setMessage('无法打开性能记录文件夹。')) }}>查看自动记录</Button>
      {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    </section>
  )
}
