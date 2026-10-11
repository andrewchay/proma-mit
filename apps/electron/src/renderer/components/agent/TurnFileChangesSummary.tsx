/**
 * TurnFileChangesSummary — Turn 底部文件改动汇总
 *
 * 在 AssistantTurnRenderer 的 MessageActions 之上展示本轮所有修改类工具调用
 * （Edit / Write / MultiEdit / NotebookEdit）所触及的文件。
 *
 * 带编辑片段（Edit / MultiEdit）的文件支持点击展开内联 diff 预览：
 * 逐个片段以 @pierre/diffs 渲染 old → new 对照，无需翻回消息流中的工具结果。
 *
 * 子代理（Agent/Task）的修改也会冒泡到此处——因为 SDK 的子代理 assistant
 * 消息同样存在于 turn.turnMessages 中（通过 parent_tool_use_id 关联）。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { ChevronDown, ChevronUp, FileDiff } from 'lucide-react'
import type { SDKMessage } from '@gravitas/shared'
import { FileDiff as PierreFileDiff } from '@pierre/diffs/react'
import { parseDiffFromFile, type FileContents, type FileDiffMetadata } from '@pierre/diffs'
import { FilePathChip } from '@/components/ai-elements/file-path-chip'
import { resolvedThemeAtom } from '@/atoms/theme'
import { cn } from '@/lib/utils'
import { collectFileChanges, type FileChangeEntry } from './turn-file-edits'
import { buildPierreDiffOptions } from './tool-result-renderers/edit-result'

/** 单个预览渲染的片段数上限，超出提示到消息流中查看 */
const MAX_PREVIEW_OPS = 10

function cheapHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h >>> 0
}

/** 单个编辑片段的 diff 视图 */
function EditOpDiff({ path, oldStr, newStr, index }: { path: string; oldStr: string; newStr: string; index: number }): React.ReactElement | null {
  const theme = useAtomValue(resolvedThemeAtom)
  const options = React.useMemo(() => buildPierreDiffOptions(theme), [theme])

  const fileDiff = React.useMemo<FileDiffMetadata | null>(() => {
    if ((!oldStr && !newStr) || oldStr === newStr) return null
    const oldFile: FileContents = { name: path, contents: oldStr, cacheKey: `old:${index}:${cheapHash(oldStr)}` }
    const newFile: FileContents = { name: path, contents: newStr, cacheKey: `new:${index}:${cheapHash(newStr)}` }
    try {
      return parseDiffFromFile(oldFile, newFile)
    } catch {
      return null
    }
  }, [path, oldStr, newStr, index])

  if (!fileDiff) return null
  return (
    <div className="rounded-md overflow-x-hidden overflow-y-auto bg-content-area max-h-[320px]">
      <PierreFileDiff fileDiff={fileDiff} options={options} />
    </div>
  )
}

/** 展开的文件级 diff 预览面板 */
function FileDiffPreview({ entry }: { entry: FileChangeEntry }): React.ReactElement {
  const visibleOps = entry.ops.slice(0, MAX_PREVIEW_OPS)
  return (
    <div className="mt-2 space-y-2">
      {visibleOps.map((op, i) => (
        <EditOpDiff key={`${entry.path}:${i}`} path={entry.path} oldStr={op.oldStr} newStr={op.newStr} index={i} />
      ))}
      {entry.ops.length > MAX_PREVIEW_OPS && (
        <p className="text-[11px] text-muted-foreground">
          本轮共 {entry.ops.length} 处编辑，仅预览前 {MAX_PREVIEW_OPS} 处，其余请在上方消息流中查看。
        </p>
      )}
    </div>
  )
}

export interface TurnFileChangesSummaryProps {
  turnMessages: SDKMessage[]
  basePath?: string
}

export function TurnFileChangesSummary({
  turnMessages,
  basePath,
}: TurnFileChangesSummaryProps): React.ReactElement | null {
  const changes = React.useMemo(() => collectFileChanges(turnMessages), [turnMessages])
  const [expandedPath, setExpandedPath] = React.useState<string | null>(null)

  if (changes.length === 0) return null

  const toggle = (path: string): void => {
    setExpandedPath((prev) => (prev === path ? null : path))
  }

  return (
    <div className="pl-[46px] mt-3">
      <div className="pt-3 border-t-2 border-dashed border-border/60">
        <div className="flex flex-wrap gap-1.5">
          {changes.map((change) => {
            const expandable = change.ops.length > 0
            if (!expandable) {
              // 整文件写入（Write / NotebookEdit）无片段可对比，保持原有文件预览
              return <FilePathChip key={change.path} filePath={change.path} basePath={basePath} />
            }
            const expanded = expandedPath === change.path
            return (
              <button
                key={change.path}
                type="button"
                onClick={() => toggle(change.path)}
                title={`${change.path} · ${expanded ? '收起' : '展开'} diff 预览`}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[12px] transition-colors',
                  expanded
                    ? 'border-primary/40 bg-primary/8 text-foreground'
                    : 'border-border/60 bg-muted/40 text-muted-foreground hover:border-primary/30 hover:text-foreground',
                )}
              >
                <FileDiff className="size-3.5 shrink-0" />
                <span className="truncate max-w-[220px]">{change.path.split('/').pop() ?? change.path}</span>
                <span className="text-[10px] opacity-60">{change.ops.length} 处</span>
                {expanded
                  ? <ChevronUp className="size-3 shrink-0 opacity-60" />
                  : <ChevronDown className="size-3 shrink-0 opacity-60" />}
              </button>
            )
          })}
        </div>
        {expandedPath && changes.find((c) => c.path === expandedPath)?.ops.length ? (
          <FileDiffPreview entry={changes.find((c) => c.path === expandedPath)!} />
        ) : null}
      </div>
    </div>
  )
}
