/**
 * Monitors Tab - 监听任务管理
 *
 * 当前为占位实现，等 MonitorService 完成后接入真实数据
 */

import * as React from 'react'
import { Monitor, GitBranch, Webhook, Terminal, Plus, Construction, FileCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'

const MONITOR_TYPES = [
  { id: 'file', label: '文件监听', icon: FileCheck, desc: '监听文件夹变化' },
  { id: 'session', label: '会话监听', icon: Monitor, desc: 'WIP 会话超时提醒' },
  { id: 'github', label: 'GitHub 监听', icon: GitBranch, desc: 'Release/CI 状态变化' },
  { id: 'webhook', label: 'Webhook', icon: Webhook, desc: '接收外部事件' },
  { id: 'command', label: '命令监听', icon: Terminal, desc: '定期执行命令检查' },
]

export function MonitorsTab(): React.ReactElement {
  const [showCreate, setShowCreate] = React.useState(false)

  return (
    <div className="p-4 space-y-4 max-w-4xl mx-auto">
      {/* 占位提示 */}
      <div className="rounded-xl border border-dashed border-amber-200/50 dark:border-amber-800/30 bg-amber-50/30 dark:bg-amber-950/10">
        <div className="flex flex-col items-center justify-center py-12">
          <Construction className="size-10 text-amber-500 mb-3" />
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">Monitor 功能即将推出</p>
          <p className="text-xs text-amber-600/70 dark:text-amber-400/70 mt-1">文件监听、会话超时提醒、GitHub Release 监控等功能正在开发中</p>
        </div>
      </div>

      {/* 监听类型概览 */}
      <div className="rounded-xl border border-border/50 bg-background shadow-sm">
        <div className="px-4 py-3 border-b border-border/50">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Monitor size={14} className="text-primary" />
            监听类型
          </h3>
        </div>
        <div className="p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {MONITOR_TYPES.map((type) => {
              const Icon = type.icon
              return (
                <button
                  key={type.id}
                  onClick={() => setShowCreate(true)}
                  className="flex items-start gap-3 p-3 rounded-lg border border-border/40 hover:border-primary/30 hover:bg-foreground/[0.02] transition-colors text-left"
                >
                  <div className="mt-0.5 p-1.5 rounded-md bg-primary/10 text-primary">
                    <Icon size={16} />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{type.label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{type.desc}</p>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
