/**
 * FilePreviewDialog - 内联文本/Markdown 文件预览弹窗
 *
 * 支持 Markdown 渲染（默认）和原始文本切换，避免纯文本白屏。
 */
import * as React from 'react'
import { X, FileText, Copy, Check, Eye, Code, ExternalLink, Maximize2 } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

interface FilePreviewDialogProps {
  filePath: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前 Agent 会话 ID（可选），用于独立预览窗口的路径权限校验 */
  sessionId?: string
  /** 候选基础目录（可选），用于独立预览窗口的相对路径解析 */
  basePaths?: string[]
}

export function FilePreviewDialog({ filePath, open, onOpenChange, sessionId, basePaths }: FilePreviewDialogProps): React.ReactElement {
  const [content, setContent] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [copied, setCopied] = React.useState(false)
  const [rawMode, setRawMode] = React.useState(false)

  const fileName = filePath ? filePath.split('/').pop() ?? filePath.split('\\').pop() ?? filePath : ''
  const isMarkdown = fileName.toLowerCase().endsWith('.md') || fileName.toLowerCase().endsWith('.markdown')

  React.useEffect(() => {
    if (!filePath || !open) {
      setContent('')
      setError('')
      setRawMode(false)
      return
    }

    setLoading(true)
    setError('')
    setRawMode(false)
    window.electronAPI
      .resolveAndReadFile(filePath)
      .then((result) => {
        if (!result) {
          setError('无法读取文件')
        } else {
          setContent(result.content)
        }
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false))
  }, [filePath, open])

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      toast.success('已复制到剪贴板')
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleOpenExternal = () => {
    if (!filePath) return
    window.electronAPI.openFile(filePath).catch(console.error)
  }

  /** 在独立窗口打开预览：可同时查看多个文档 */
  const handleOpenDetached = () => {
    if (!filePath) return
    const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
    window.electronAPI
      .openDetachedPreview({
        // 无会话上下文（如 Campaign 产物列表）时使用占位 sessionId，
        // 主进程路径校验仍会放行 agent-workspaces 内的文件
        sessionId: sessionId ?? 'detached-preview',
        filePath,
        dirPath: slash > 0 ? filePath.slice(0, slash) : filePath,
        previewOnly: true,
        readOnly: true,
        basePaths,
        title: fileName,
      })
      .then((id) => {
        if (id) onOpenChange(false)
      })
      .catch((err) => {
        console.error('[FilePreviewDialog] 打开独立预览窗口失败:', err)
        toast.error('打开独立预览窗口失败')
      })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 py-4 border-b border-border flex flex-row items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileText size={16} className="text-muted-foreground flex-shrink-0" />
            <DialogTitle className="text-sm font-semibold truncate">
              {fileName}
            </DialogTitle>
          </div>
          <div className="flex items-center gap-1">
            {isMarkdown && content && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2 text-xs"
                onClick={() => setRawMode((prev) => !prev)}
                title={rawMode ? '切换到渲染视图' : '切换到原始文本'}
              >
                {rawMode ? <Eye size={13} /> : <Code size={13} />}
                <span className="ml-1">{rawMode ? '渲染' : '原文'}</span>
              </Button>
            )}
            {content && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2 text-xs"
                onClick={handleCopy}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                <span className="ml-1">{copied ? '已复制' : '复制'}</span>
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={handleOpenDetached}
              title="在独立窗口打开，可同时查看多个文档"
            >
              <Maximize2 size={13} />
              <span className="ml-1">独立窗口</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={handleOpenExternal}
              title="用系统应用打开"
            >
              <ExternalLink size={13} />
              <span className="ml-1">打开</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0"
              onClick={() => onOpenChange(false)}
            >
              <X size={14} />
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              加载中...
            </div>
          ) : error ? (
            <div className="text-sm text-red-500 py-8 text-center">{error}</div>
          ) : isMarkdown && !rawMode ? (
            <div
              className="prose dark:prose-invert max-w-none text-[14px]
                prose-p:my-2 prose-p:leading-[1.75] prose-li:leading-[1.75]
                prose-headings:my-3 prose-pre:my-0
                prose-img:rounded-xl prose-img:shadow-md prose-img:max-w-full
                prose-blockquote:border-primary/30 prose-blockquote:text-muted-foreground
                [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            >
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children: linkChildren, ...linkProps }) => (
                    <a
                      {...linkProps}
                      href={href}
                      onClick={(e) => {
                        e.preventDefault()
                        if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
                          window.electronAPI.openExternal(href)
                        }
                      }}
                      title={href}
                      className="text-primary hover:underline cursor-pointer"
                    >
                      {linkChildren}
                    </a>
                  ),
                }}
              >
                {content}
              </Markdown>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words text-sm font-mono leading-relaxed">
              {content}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
