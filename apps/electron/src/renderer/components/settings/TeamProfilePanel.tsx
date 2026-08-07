/**
 * TeamProfilePanel — 团队档案编辑（PH2-A）
 *
 * 编辑当前工作区的「团队档案」（最简大上下文同步），
 * 该档案会被注入 Agent system prompt 的动态上下文（buildTeamProfileContext）。
 * 字段：团队名 / 团队构成 / 当前方向 / 协作偏好。
 */

import * as React from 'react'
import { SettingsSection, SettingsCard } from './primitives'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Save } from 'lucide-react'
import type { TeamProfile } from '@gravitas/shared'

export function TeamProfilePanel({ workspaceSlug }: { workspaceSlug: string }): React.ReactElement {
  const [draft, setDraft] = React.useState<Pick<TeamProfile, 'teamName' | 'membersSummary' | 'focusAreas' | 'preferences'>>({
    teamName: '', membersSummary: '', focusAreas: '', preferences: '',
  })
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!workspaceSlug) return
    void (async () => {
      try {
        const p = await window.electronAPI.getTeamProfile(workspaceSlug)
        setDraft({ teamName: p.teamName, membersSummary: p.membersSummary, focusAreas: p.focusAreas, preferences: p.preferences })
      } catch {
        // 忽略
      }
    })()
  }, [workspaceSlug])

  const set = (k: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }))

  const save = async (): Promise<void> => {
    if (!workspaceSlug) return
    setSaving(true)
    try {
      await window.electronAPI.updateTeamProfile(workspaceSlug, draft)
      toast.success('团队档案已保存')
    } catch (err) {
      toast.error('保存失败')
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  const field = (label: string, key: keyof typeof draft, textarea = false) => (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {textarea ? (
        <textarea value={draft[key]} onChange={set(key)} rows={2} className="w-full px-2.5 py-1.5 rounded-md border bg-background text-sm resize-none" />
      ) : (
        <input value={draft[key]} onChange={set(key)} className="w-full px-2.5 py-1.5 rounded-md border bg-background text-sm" />
      )}
    </label>
  )

  return (
    <SettingsSection
      title="团队档案"
      description="团队级大上下文（注入 Agent 提示词）：让 Agent 了解团队背景并以合适方式协作。"
      action={
        <Button variant="outline" size="sm" onClick={() => void save()} disabled={saving}>
          <Save size={14} /> 保存
        </Button>
      }
    >
      <SettingsCard>
        <div className="grid grid-cols-2 gap-3 p-4">
          {field('团队名', 'teamName')}
          {field('协作偏好', 'preferences')}
          <div className="col-span-2">{field('团队构成（成员：职责）', 'membersSummary', true)}</div>
          <div className="col-span-2">{field('当前方向/关注', 'focusAreas', true)}</div>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
