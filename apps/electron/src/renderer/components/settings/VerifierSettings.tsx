/**
 * VerifierSettings — 受保护验证器配置（固定基线验证）
 *
 * 验证配置与受保护路径由受保护存储统一维护（HMAC 签名 + safeStorage 密钥）。
 * 保存会递增修订：引用旧修订的 Goal 完成时会被拒绝，需要重新创建 Goal。
 * 此页面是唯一的写入入口；Agent 没有写入能力。
 */

import * as React from 'react'
import { ShieldCheck, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { SettingsInput } from './primitives/SettingsInput'
import { SettingsTextarea } from './primitives/SettingsTextarea'
import { Button } from '@/components/ui/button'
import type { VerifierSummary } from '@gravitas/shared'

const EMPTY_FORM = {
  verifierId: '',
  argv: '',
  expectedExitCodes: '0',
  timeoutMs: '600000',
  minimumTests: '1',
  protectedPaths: '**/*.test.ts',
}

function splitLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

export function VerifierSettings(): React.ReactElement {
  const [list, setList] = React.useState<VerifierSummary[] | null>(null)
  const [form, setForm] = React.useState(EMPTY_FORM)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  const load = React.useCallback(async () => {
    if (!window.electronAPI?.verifierList) {
      setList([])
      return
    }
    try {
      setList(await window.electronAPI.verifierList())
    } catch (error) {
      toast.error(`读取验证器失败：${error instanceof Error ? error.message : String(error)}`)
      setList([])
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  const startEdit = (summary: VerifierSummary): void => {
    setEditingId(summary.verifierId)
    setForm({
      verifierId: summary.verifierId,
      argv: summary.config.argv.join('\n'),
      expectedExitCodes: summary.config.expectedExitCodes.join(','),
      timeoutMs: String(summary.config.timeoutMs),
      minimumTests: String(summary.config.minimumTests),
      protectedPaths: summary.protectedPaths.join('\n'),
    })
    setConfirming(false)
  }

  const reset = (): void => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setConfirming(false)
  }

  const save = async (): Promise<void> => {
    if (!window.electronAPI?.verifierSave) {
      toast.error('当前环境不支持验证器配置')
      return
    }
    setSaving(true)
    try {
      const saved = await window.electronAPI.verifierSave({
        verifierId: form.verifierId.trim(),
        config: {
          version: 1,
          verifierId: form.verifierId.trim(),
          argv: splitLines(form.argv),
          expectedExitCodes: form.expectedExitCodes.split(',').map((code) => Number(code.trim())).filter((code) => Number.isInteger(code)),
          timeoutMs: Number(form.timeoutMs),
          minimumTests: Number(form.minimumTests),
        },
        protectedPaths: splitLines(form.protectedPaths),
      })
      toast.success(`已保存验证器 ${saved.verifierId}（修订 ${saved.revision}）`)
      reset()
      await load()
    } catch (error) {
      toast.error(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsSection
      title="验证器"
      description="固定基线验证配置与受保护路径由签名存储统一维护。保存会递增修订，引用旧修订的 Goal 需要重新创建。"
    >
      <SettingsCard>
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium">已有验证器</div>
          <Button variant="outline" size="sm" onClick={() => { void load() }}>
            <RefreshCw size={14} className="mr-1" /> 刷新
          </Button>
        </div>
        {list === null ? (
          <div className="text-sm text-foreground/50">加载中…</div>
        ) : list.length === 0 ? (
          <div className="text-sm text-foreground/50">暂无验证器配置。</div>
        ) : (
          <div className="space-y-2">
            {list.map((summary) => (
              <div key={summary.verifierId} className="flex items-center justify-between rounded-md border border-foreground/10 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{summary.verifierId}</div>
                  <div className="text-xs text-foreground/50">
                    {summary.error
                      ? `记录不可用：${summary.error}`
                      : `修订 ${summary.revision} · ${summary.protectedPaths.length} 条受保护路径 · ${summary.config.argv.join(' ')}`}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => { startEdit(summary) }}>编辑</Button>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>

      <SettingsCard>
        <div className="flex items-center gap-2 mb-3">
          <ShieldCheck size={16} />
          <div className="text-sm font-medium">{editingId ? `编辑验证器：${editingId}` : '新建验证器'}</div>
        </div>
        <div className="space-y-3">
          <SettingsInput
            label="验证器 ID"
            description="小写字母、数字与连字符；保存后作为 Goal 门禁的引用标识。"
            value={form.verifierId}
            onChange={(value) => { setForm({ ...form, verifierId: value }) }}
            placeholder="bun-unit-tests"
            disabled={editingId !== null}
          />
          <SettingsTextarea
            label="验证命令（argv，每行一个参数）"
            description="首行为可执行文件；不经 shell 解释。可用 {{JUNIT_REPORT}} 占位符指定测试报告路径。"
            value={form.argv}
            onChange={(value) => { setForm({ ...form, argv: value }) }}
            placeholder={'bun\ntest\n--reporter=junit\n--reporter-outfile={{JUNIT_REPORT}}'}
            minHeight={96}
          />
          <div className="grid grid-cols-3 gap-3">
            <SettingsInput label="允许的退出码（逗号分隔）" value={form.expectedExitCodes} onChange={(value) => { setForm({ ...form, expectedExitCodes: value }) }} />
            <SettingsInput label="超时（毫秒）" value={form.timeoutMs} onChange={(value) => { setForm({ ...form, timeoutMs: value }) }} />
            <SettingsInput label="最少测试数" value={form.minimumTests} onChange={(value) => { setForm({ ...form, minimumTests: value }) }} />
          </div>
          <SettingsTextarea
            label="受保护路径（每行一个模式）"
            description="基线提交之后不得在这些路径上产生改动，例如测试文件。支持 **/、*、目录前缀与精确路径。"
            value={form.protectedPaths}
            onChange={(value) => { setForm({ ...form, protectedPaths: value }) }}
            placeholder={'**/*.test.ts\ntests/'}
            minHeight={72}
          />
          {editingId !== null && !confirming && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-600">
              保存将产生新修订。引用修订 {list?.find((item) => item.verifierId === editingId)?.revision ?? '?'} 的 Goal 在验证时会失败，需要重新创建。
            </div>
          )}
          <div className="flex gap-2">
            {editingId !== null && !confirming ? (
              <Button size="sm" onClick={() => { setConfirming(true) }}>确认修改</Button>
            ) : (
              <Button size="sm" disabled={saving || !form.verifierId.trim() || splitLines(form.argv).length === 0} onClick={() => { void save() }}>
                <Plus size={14} className="mr-1" /> {saving ? '保存中…' : '保存'}
              </Button>
            )}
            {editingId !== null && (
              <Button variant="ghost" size="sm" onClick={reset}>取消</Button>
            )}
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
