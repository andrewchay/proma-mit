import * as React from 'react'
import { Bot, Pause, Play, Trash2 } from 'lucide-react'
import type { NewMediaAutomationRule, NewMediaPlatform } from '@gravitas/shared'

const PLATFORM_LABEL: Record<NewMediaPlatform, string> = {
  xiaohongshu: '小红书',
  'wechat-official-account': '微信公众号',
}

function cadenceLabel(rule: NewMediaAutomationRule): string {
  return rule.cadence.type === 'daily'
    ? `每天 ${rule.cadence.timeOfDay}`
    : `每 ${rule.cadence.hours} 小时`
}

/**
 * 自动化排程：定时生成「待审批」外发动作。
 *
 * 明确告知用户安全边界：自动化永远不会自动执行外发；
 * 每次触发只产生一条待人工审批的请求，连续失败会自动停用规则。
 */
export function AutomationPanel({ onRefresh }: { onRefresh: () => Promise<void> }): React.ReactElement {
  const [rules, setRules] = React.useState<NewMediaAutomationRule[]>([])
  const [platform, setPlatform] = React.useState<NewMediaPlatform>('wechat-official-account')
  const [kind, setKind] = React.useState<'publish' | 'send-reply'>('publish')
  const [targetId, setTargetId] = React.useState('')
  const [summary, setSummary] = React.useState('')
  const [cadenceType, setCadenceType] = React.useState<'daily' | 'intervalHours'>('daily')
  const [timeOfDay, setTimeOfDay] = React.useState('09:00')
  const [hours, setHours] = React.useState('24')
  const [notice, setNotice] = React.useState('')

  const reload = React.useCallback(async (): Promise<void> => {
    setRules(await window.electronAPI.paa.newMedia.automation.listRules())
  }, [])
  React.useEffect(() => { void reload() }, [reload])

  const create = async (): Promise<void> => {
    setNotice('')
    if (!targetId.trim()) { setNotice('请填写目标内容标识（如微信草稿记录 id）'); return }
    try {
      await window.electronAPI.paa.newMedia.automation.createRule({
        accountId: 'local-user-account',
        platform,
        kind,
        targetId: targetId.trim(),
        summaryTemplate: summary.trim() || `自动化外发 {{date}}`,
        cadence: cadenceType === 'daily' ? { type: 'daily', timeOfDay } : { type: 'intervalHours', hours: Number(hours) },
      })
      setNotice('规则已创建；触发时只会生成待审批动作。')
      setTargetId('')
      await reload()
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '创建失败')
    }
  }

  const toggle = async (rule: NewMediaAutomationRule): Promise<void> => {
    await window.electronAPI.paa.newMedia.automation.setEnabled(rule.id, !rule.enabled, rule.enabled ? '人工暂停' : undefined)
    await reload()
  }

  const remove = async (rule: NewMediaAutomationRule): Promise<void> => {
    if (!window.confirm('删除该自动化规则？运行历史会保留以便追溯。')) return
    await window.electronAPI.paa.newMedia.automation.deleteRule(rule.id)
    await reload()
  }

  const runDue = async (): Promise<void> => {
    const result = await window.electronAPI.paa.newMedia.automation.tick()
    setNotice(`已处理到期规则 ${result.triggered} 条：生成审批 ${result.created}，失败 ${result.failed}，跳过 ${result.skipped}。`)
    await reload()
    await onRefresh()
  }

  return <section className="rounded-2xl bg-background p-4 shadow-sm">
    <div className="flex items-center gap-2"><Bot size={17} /><h2 className="font-medium">自动化排程</h2></div>
    <p className="mt-1 text-sm text-foreground/55">定时生成待审批外发动作。自动化不会执行任何外发；每次触发都需要人工审批，连续 3 次失败会自动停用规则。</p>

    <div className="mt-3 flex flex-wrap items-end gap-2">
      <label className="text-xs text-foreground/60">平台
        <select value={platform} onChange={(event) => setPlatform(event.target.value as NewMediaPlatform)} className="mt-1 block rounded-lg bg-muted px-3 py-2 text-sm">
          <option value="wechat-official-account">微信公众号</option>
        </select>
      </label>
      <label className="text-xs text-foreground/60">动作
        <select value={kind} onChange={(event) => setKind(event.target.value as 'publish' | 'send-reply')} className="mt-1 block rounded-lg bg-muted px-3 py-2 text-sm">
          <option value="publish">发布</option>
          <option value="send-reply">回复</option>
        </select>
      </label>
      <label className="text-xs text-foreground/60">节奏
        <select value={cadenceType} onChange={(event) => setCadenceType(event.target.value as 'daily' | 'intervalHours')} className="mt-1 block rounded-lg bg-muted px-3 py-2 text-sm">
          <option value="daily">每天定时</option>
          <option value="intervalHours">固定间隔</option>
        </select>
      </label>
      {cadenceType === 'daily'
        ? <input type="time" value={timeOfDay} onChange={(event) => setTimeOfDay(event.target.value)} className="rounded-lg bg-muted px-3 py-2 text-sm" />
        : <input value={hours} onChange={(event) => setHours(event.target.value)} placeholder="小时数" className="w-24 rounded-lg bg-muted px-3 py-2 text-sm" />}
      <label className="text-xs text-foreground/60">目标内容
        <input value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder="草稿记录 id" className="mt-1 block w-48 rounded-lg bg-muted px-3 py-2 text-sm" />
      </label>
      <label className="text-xs text-foreground/60">摘要模板
        <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="支持 {{date}} 占位" className="mt-1 block w-56 rounded-lg bg-muted px-3 py-2 text-sm" />
      </label>
      <button onClick={() => void create()} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">创建规则</button>
      <button onClick={() => void runDue()} className="rounded-lg px-3 py-2 text-sm hover:bg-muted">立即处理到期任务</button>
    </div>

    {notice && <div className="mt-3 rounded-lg bg-muted p-3 text-sm text-foreground/70">{notice}</div>}

    <div className="mt-4 space-y-2">
      {rules.map((rule) => <div key={rule.id} className="rounded-xl bg-muted/45 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{PLATFORM_LABEL[rule.platform]} · {rule.kind === 'publish' ? '发布' : '回复'}</span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] ${rule.enabled ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-foreground/55'}`}>
            {rule.enabled ? '启用中' : `已停用${rule.autoDisabledReason ? `（${rule.autoDisabledReason}）` : ''}`}
          </span>
        </div>
        <div className="mt-1 text-xs text-foreground/55">{cadenceLabel(rule)} · 下次触发 {new Date(rule.nextRunAt).toLocaleString('zh-CN')}</div>
        <div className="mt-0.5 text-xs text-foreground/45">目标 {rule.targetId} · 连续失败 {rule.consecutiveFailures} 次</div>
        <div className="mt-2 flex justify-end gap-2">
          <button onClick={() => void toggle(rule)} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs hover:bg-background">
            {rule.enabled ? <><Pause size={12} />暂停</> : <><Play size={12} />启用</>}
          </button>
          <button onClick={() => void remove(rule)} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10"><Trash2 size={12} />删除</button>
        </div>
      </div>)}
      {rules.length === 0 && <div className="py-4 text-center text-sm text-foreground/45">暂无自动化规则</div>}
    </div>
  </section>
}
