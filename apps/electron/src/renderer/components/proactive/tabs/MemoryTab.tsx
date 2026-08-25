/**
 * Memory Tab - 记忆管理
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Brain, Construction } from 'lucide-react'
import { proactiveMemoryPluginsAtom } from '@/atoms/proactive-data'

export function MemoryTab(): React.ReactElement {
  const [memoryPlugins] = useAtom(proactiveMemoryPluginsAtom)

  return (
    <div className="p-4 space-y-4 max-w-4xl mx-auto">
      {/* 占位提示 */}
      <div className="rounded-xl border border-dashed border-amber-200/50 dark:border-amber-800/30 bg-amber-50/30 dark:bg-amber-950/10">
        <div className="flex flex-col items-center justify-center py-16">
          <Construction className="size-10 text-amber-500 mb-3" />
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">Memory Plugin 功能即将推出</p>
          <p className="text-xs text-amber-600/70 dark:text-amber-400/70 mt-1">记忆插件管理正在开发中</p>
        </div>
      </div>

      {memoryPlugins.length > 0 && (
        <div className="rounded-xl border border-border/50 bg-background shadow-sm">
          <div className="px-4 py-3 border-b border-border/50">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Brain size={14} className="text-primary" />
              已启用记忆插件 ({memoryPlugins.length})
            </h3>
          </div>
          <div className="p-4 space-y-2">
            {memoryPlugins.map((plugin) => (
              <div key={plugin.id} className="flex items-center gap-3 p-3 rounded-lg bg-foreground/[0.02] border border-border/40">
                <Brain size={16} className="text-primary flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{plugin.name}</p>
                  <p className="text-xs text-muted-foreground">{plugin.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
