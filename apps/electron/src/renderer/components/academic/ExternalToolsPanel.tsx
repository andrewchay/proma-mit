/**
 * ExternalToolsPanel - 外部工具集成（M6）
 *
 * 展示登记的外部工具及其探测状态。三处刻意的设计：
 * 1. **不内置上游产物**：面板明确写"需你自行安装"，不提供下载按钮
 * 2. **启用需两步**：确认许可条款（附来源链接）+ 填写实际安装版本
 * 3. **descriptor-only 工具不可启用**：只登记能力，不提供执行路径
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Loader2, Plug, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  externalToolsAtom,
  externalToolsLoadingAtom,
  probeExternalToolsAtom,
  setExternalToolAtom,
} from '@/atoms/academic-atoms'

const STATUS_LABELS: Record<string, string> = {
  available: '可用',
  'not-installed': '未安装',
  'version-mismatch': '版本不符',
  'license-not-acknowledged': '待确认许可',
  disabled: '未启用',
  'probe-error': '探测失败',
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  available: 'default',
  disabled: 'secondary',
  'not-installed': 'outline',
  'version-mismatch': 'destructive',
  'license-not-acknowledged': 'outline',
  'probe-error': 'destructive',
}

export function ExternalToolsPanel(): React.ReactElement {
  const tools = useAtomValue(externalToolsAtom)
  const loading = useAtomValue(externalToolsLoadingAtom)
  const probe = useSetAtom(probeExternalToolsAtom)

  React.useEffect(() => {
    void probe()
  }, [probe])

  return (
    <div className="mt-4 space-y-3 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4 text-primary" />
          <span className="text-base font-semibold">外部工具集成</span>
          <span className="text-xs text-muted-foreground">
            不内置任何上游产物；需你自行安装并确认许可
          </span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void probe()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          重新探测
        </Button>
      </div>

      {tools.length === 0 && !loading && (
        <div className="text-sm text-muted-foreground">尚未探测。点击「重新探测」查看本机工具状态。</div>
      )}

      {tools.map((tool) => (
        <ToolRow key={tool.descriptor.id} tool={tool} />
      ))}
    </div>
  )
}

function ToolRow({
  tool,
}: {
  tool: ReturnType<typeof useAtomValue<typeof externalToolsAtom>>[number]
}): React.ReactElement {
  const setTool = useSetAtom(setExternalToolAtom)
  const [ack, setAck] = React.useState(Boolean(tool.config.licenseAcknowledgedAt))
  const [version, setVersion] = React.useState(tool.config.pinnedVersion ?? '')
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  const isDescriptorOnly = tool.descriptor.role === 'descriptor-only'

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{tool.descriptor.name}</span>
            <Badge variant={STATUS_VARIANT[tool.status] ?? 'secondary'}>
              {STATUS_LABELS[tool.status] ?? tool.status}
            </Badge>
            {isDescriptorOnly && <Badge variant="outline" className="text-[10px]">仅登记描述符</Badge>}
            {tool.detectedVersion && <span className="text-xs text-muted-foreground">v{tool.detectedVersion}</span>}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {tool.descriptor.capabilities.join(' · ')}
          </div>
          {tool.detail && <div className="mt-1 text-xs text-amber-600">{tool.detail}</div>}
          <div className="mt-1 text-[11px] text-muted-foreground">
            许可：{tool.descriptor.licenseNote} ·{' '}
            <span className="underline">{tool.descriptor.homepage}</span>
          </div>
          {tool.descriptor.prerequisites.length > 0 && (
            <div className="mt-1 text-[11px] text-muted-foreground">
              前置条件：{tool.descriptor.prerequisites.join('；')}
            </div>
          )}
        </div>

        {!isDescriptorOnly && (
          <Button
            size="sm"
            variant={tool.config.enabled ? 'ghost' : 'outline'}
            className="h-7 shrink-0 px-2 text-xs"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setMessage(null)
              try {
                if (tool.config.enabled) {
                  await setTool({ toolId: tool.descriptor.id, enabled: false })
                } else {
                  await setTool({
                    toolId: tool.descriptor.id,
                    enabled: true,
                    licenseAcknowledged: ack,
                    pinnedVersion: version,
                  })
                }
              } catch (err) {
                setMessage(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            {tool.config.enabled ? '停用' : '启用'}
          </Button>
        )}
      </div>

      {!isDescriptorOnly && !tool.config.enabled && (
        <div className="space-y-2 rounded border bg-muted/30 p-2">
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>我已阅读并确认上述许可条款（自行承担使用责任）</span>
          </label>
          <Input
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="实际安装版本（用于事后复现，如 0.4.2）"
            className="h-8 text-xs"
          />
        </div>
      )}

      {message && <p className="text-xs text-destructive">{message}</p>}
    </div>
  )
}
