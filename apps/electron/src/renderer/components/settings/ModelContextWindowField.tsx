import * as React from 'react'
import type { ChannelModel, ProviderType } from '@gravitas/shared'
import { resolveModelContextCapability } from '@gravitas/shared'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const SOURCE_LABELS = { api: 'API 返回', catalog: '模型目录', override: '手动设置', fallback: '未识别，暂用回退值' }

/** 模型窗口按渠道保存；清空即可恢复自动识别。 */
export function ModelContextWindowField({ model, provider, onChange }: {
  model: ChannelModel
  provider: ProviderType
  onChange: (contextWindowOverride: number | undefined) => void
}): React.ReactElement {
  const capability = resolveModelContextCapability({ provider, modelId: model.id, ...model })
  const [draft, setDraft] = React.useState(model.contextWindowOverride?.toString() ?? '')
  const [error, setError] = React.useState(false)
  React.useEffect(() => { setDraft(model.contextWindowOverride?.toString() ?? '') }, [model.contextWindowOverride])
  const save = (): void => {
    const value = draft.trim() ? Number(draft) : undefined
    if (value !== undefined && (!/^\d+$/.test(draft.trim()) || !Number.isSafeInteger(value) || value <= 0)) {
      setError(true)
      return
    }
    setError(false)
    onChange(value)
  }
  return (
    <div className="w-full space-y-1 pl-6">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`context-${model.id}`} className="text-xs text-muted-foreground">上下文窗口（tokens）</label>
        <Input
          id={`context-${model.id}`}
          className="h-7 w-36 text-xs"
          inputMode="numeric"
          value={draft}
          placeholder={String(capability.contextWindow)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); save() } }}
          aria-invalid={error}
        />
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => {
          setDraft('')
          setError(false)
          onChange(undefined)
        }}>自动</Button>
      </div>
      <p className="text-xs text-muted-foreground" role={error ? 'alert' : undefined}>
        {error ? '请输入正整数，单位为 tokens；留空恢复自动识别。'
          : `${SOURCE_LABELS[capability.source]} · ${capability.contextWindow.toLocaleString()} tokens${capability.source === 'fallback' ? '；请刷新模型列表或手动设置' : ''}`}
      </p>
    </div>
  )
}
