/**
 * ProtocolPanel - 研究协议面板（M3）
 *
 * 展示当前协议版本、按领域 profile 填写字段、勾选检查项后批准；
 * 已批准版本可通过「修订」产生新版本（旧批准不沿用）。
 *
 * 领域字段元数据（标签/必填/提示）在服务层 profile 中定义；
 * 渲染层通过 IPC 只读获取，避免两处维护同一份规则。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { FileCheck2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  approveProtocolAtom,
  createProtocolAtom,
  loadProtocolsAtom,
  protocolChecksAtom,
  protocolFieldsAtom,
  protocolsAtom,
  reviseProtocolAtom,
} from '@/atoms/academic-atoms'
import type { ResearchProject, ResearchProtocol } from '@gravitas/shared'

const STATUS_LABELS: Record<ResearchProtocol['status'], string> = {
  draft: '草稿',
  approved: '已批准',
  superseded: '已被取代',
}

export function ProtocolPanel({ project }: { project: ResearchProject }): React.ReactElement {
  const protocols = useAtomValue(protocolsAtom)
  const fields = useAtomValue(protocolFieldsAtom)
  const checks = useAtomValue(protocolChecksAtom)
  const load = useSetAtom(loadProtocolsAtom)
  const createProtocol = useSetAtom(createProtocolAtom)
  const approveProtocol = useSetAtom(approveProtocolAtom)
  const reviseProtocol = useSetAtom(reviseProtocolAtom)

  const [draftFields, setDraftFields] = React.useState<Record<string, string>>({})
  const [acknowledged, setAcknowledged] = React.useState<string[]>([])
  const [changeReason, setChangeReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  React.useEffect(() => {
    void load({ projectId: project.id, domain: project.domain, methodPath: project.methodPath })
  }, [project.id, project.domain, project.methodPath, load])

  const latest = protocols.length > 0 ? protocols[protocols.length - 1]! : null
  const editing = latest?.status === 'draft' || latest === null

  const textFields = fields.filter((f) => f.type === 'text' || f.type === 'longtext' || f.type === 'number')
  const listFields = fields.filter((f) => f.type === 'list')
  const selectFields = fields.filter((f) => f.type === 'select')

  return (
    <div className="mt-4 space-y-3 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileCheck2 className="h-4 w-4 text-primary" />
          <span className="text-base font-semibold">研究协议</span>
          {latest && (
            <>
              <Badge variant="outline">v{latest.version}</Badge>
              <Badge variant={latest.status === 'approved' ? 'default' : 'secondary'}>
                {STATUS_LABELS[latest.status]}
              </Badge>
            </>
          )}
        </div>
        {latest?.status === 'approved' && (
          <span className="text-xs text-muted-foreground">
            已由 {latest.approval?.approvedBy.displayName} 批准
          </span>
        )}
      </div>

      {message && <p className="text-xs text-muted-foreground">{message}</p>}

      {/* 字段编辑区：草稿或未创建时可见 */}
      {editing && (
        <div className="space-y-2">
          {latest?.changeReason && (
            <p className="text-xs text-muted-foreground">修订理由：{latest.changeReason}</p>
          )}
          {selectFields.map((f) => (
            <select
              key={f.key}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={draftFields[f.key] ?? f.options?.[0] ?? ''}
              onChange={(e) => setDraftFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
            >
              {(f.options ?? []).map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          ))}
          {textFields.map((f) => (
            <div key={f.key} className="space-y-1">
              <div className="text-xs text-muted-foreground">
                {f.label}
                {(f as { required?: boolean }).required ? ' *' : ''}
                {(f as { hint?: string }).hint ? ` · ${(f as { hint?: string }).hint}` : ''}
              </div>
              <Textarea
                rows={2}
                value={draftFields[f.key] ?? ''}
                onChange={(e) => setDraftFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            </div>
          ))}
          {listFields.map((f) => (
            <div key={f.key} className="space-y-1">
              <div className="text-xs text-muted-foreground">
                {f.label}（每行一项）
                {(f as { hint?: string }).hint ? ` · ${(f as { hint?: string }).hint}` : ''}
              </div>
              <Textarea
                rows={2}
                value={draftFields[f.key] ?? ''}
                onChange={(e) => setDraftFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            </div>
          ))}
        </div>
      )}

      {/* 检查项：批准前必须全部确认 */}
      {editing && latest && (
        <div className="space-y-1 rounded-md border bg-muted/30 p-3">
          <div className="text-xs font-medium">批准前须确认的检查项</div>
          {checks.map((c) => (
            <label key={c.id} className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={acknowledged.includes(c.id)}
                onChange={() =>
                  setAcknowledged((prev) =>
                    prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id],
                  )
                }
              />
              <span>{c.description}</span>
            </label>
          ))}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {latest?.status === 'draft' && (
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setMessage(null)
              try {
                await approveProtocol({
                  projectId: project.id,
                  version: latest.version,
                  input: { acknowledgedChecks: acknowledged },
                })
                setMessage(`协议 v${latest.version} 已批准`)
              } catch (err) {
                setMessage(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            批准协议 v{latest.version}
          </Button>
        )}
        {!latest && (
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setMessage(null)
              try {
                await createProtocol({
                  projectId: project.id,
                  methodPath: project.methodPath,
                  fields: normalizeFields(draftFields, listFields.map((f) => f.key)),
                })
                setMessage('已创建协议草稿')
              } catch (err) {
                setMessage(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            创建协议草稿
          </Button>
        )}

        {latest?.status === 'approved' && (
          <div className="flex w-full items-center gap-2">
            <Input
              value={changeReason}
              onChange={(e) => setChangeReason(e.target.value)}
              placeholder="修订理由（必填）"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !changeReason.trim()}
              onClick={async () => {
                setBusy(true)
                setMessage(null)
                try {
                  await reviseProtocol({
                    projectId: project.id,
                    changeReason,
                    methodPath: latest.methodPath,
                    fields: { ...latest.fields },
                  })
                  setChangeReason('')
                  setMessage('已创建新版本草稿；旧版本标记为已被取代')
                } catch (err) {
                  setMessage(err instanceof Error ? err.message : String(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              修订协议
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** list 字段按行拆分（空行丢弃） */
function normalizeFields(
  fields: Record<string, string>,
  listKeys: string[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = listKeys.includes(key)
      ? value.split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
      : value
  }
  return out
}
