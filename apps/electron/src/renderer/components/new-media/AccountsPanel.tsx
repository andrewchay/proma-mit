import * as React from 'react'
import type { NewMediaAccountAuditEntry, NewMediaConnectedAccount, NewMediaPlatform } from '@gravitas/shared'

const PLATFORM_LABEL: Record<NewMediaPlatform, string> = {
  xiaohongshu: '小红书',
  'wechat-official-account': '微信公众号',
}

const STATUS_LABEL: Record<NewMediaConnectedAccount['status'], string> = {
  disconnected: '未连接',
  authorization_pending: '等待授权',
  connected: '已连接',
  expired: '已过期',
  revoked: '已撤销',
  error: '连接异常',
}

export function AccountsPanel(): React.ReactElement {
  const [accounts, setAccounts] = React.useState<NewMediaConnectedAccount[]>([])
  const [platform, setPlatform] = React.useState<NewMediaPlatform>('xiaohongshu')
  const [displayName, setDisplayName] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [audit, setAudit] = React.useState<Record<string, NewMediaAccountAuditEntry[]>>({})

  const refresh = React.useCallback(async () => setAccounts(await window.electronAPI.paa.newMedia.accounts.list()), [])
  React.useEffect(() => { void refresh() }, [refresh])

  const create = async (): Promise<void> => {
    if (!displayName.trim()) return
    await window.electronAPI.paa.newMedia.accounts.create({ platform, displayName })
    setDisplayName('')
    setNotice('账号占位已创建，尚未连接真实平台。')
    await refresh()
  }

  const beginAuthorization = async (account: NewMediaConnectedAccount): Promise<void> => {
    const result = await window.electronAPI.paa.newMedia.accounts.beginAuthorization(account.id)
    setNotice(result.description)
    await refresh()
  }

  const showAudit = async (accountId: string): Promise<void> => {
    const entries = await window.electronAPI.paa.newMedia.accounts.audit(accountId)
    setAudit((current) => ({ ...current, [accountId]: entries }))
  }

  return <div className="mx-auto max-w-5xl space-y-5">
    <section className="rounded-2xl bg-background p-4 shadow-sm">
      <h2 className="font-medium">账号连接模型</h2>
      <p className="mt-1 text-sm text-foreground/55">当前仅建立账号和授权边界，不会打开登录页、收集 Token 或连接真实平台。</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <select value={platform} onChange={(event) => setPlatform(event.target.value as NewMediaPlatform)} className="rounded-lg bg-muted px-3 py-2 text-sm">
          <option value="xiaohongshu">小红书</option><option value="wechat-official-account">微信公众号</option>
        </select>
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="账号备注名称" className="min-w-56 flex-1 rounded-lg bg-muted px-3 py-2 text-sm outline-none ring-primary/30 focus:ring-2" />
        <button onClick={() => void create()} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">添加账号占位</button>
      </div>
      {notice && <div className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">{notice}</div>}
    </section>

    <section className="grid gap-3 md:grid-cols-2">
      {accounts.map((account) => <article key={account.id} className="rounded-2xl bg-background p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3"><div><div className="font-medium">{account.displayName}</div><div className="mt-1 text-xs text-foreground/45">{PLATFORM_LABEL[account.platform]}</div></div><span className="rounded-full bg-muted px-2 py-1 text-xs">{STATUS_LABEL[account.status]}</span></div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-foreground/60">
          <span>本地草稿：{account.capabilities.localDraft ? '可用' : '不可用'}</span><span>真实发布：{account.capabilities.publish ? '可用' : '未开放'}</span>
          <span>互动读取：{account.capabilities.readEngagements ? '可用' : '未开放'}</span><span>凭据保护：{account.credentialProtection === 'none' ? '无凭据' : account.credentialProtection}</span>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={() => void showAudit(account.id)} className="rounded-lg px-3 py-1.5 text-xs hover:bg-muted">查看审计</button>
          {account.status === 'connected' ? <button onClick={async () => { await window.electronAPI.paa.newMedia.accounts.disconnect(account.id); await refresh() }} className="rounded-lg bg-destructive/10 px-3 py-1.5 text-xs text-destructive">断开</button> : <button onClick={() => void beginAuthorization(account)} className="rounded-lg bg-primary/10 px-3 py-1.5 text-xs text-primary">开始授权</button>}
        </div>
        {audit[account.id] && <div className="mt-3 space-y-1 border-t border-border/40 pt-3">{(audit[account.id] ?? []).map((entry) => <div key={entry.id} className="text-xs text-foreground/55">{new Date(entry.createdAt).toLocaleString()} · {entry.detail}</div>)}</div>}
      </article>)}
      {accounts.length === 0 && <div className="col-span-full rounded-2xl bg-background p-8 text-center text-sm text-foreground/45 shadow-sm">尚未创建账号占位</div>}
    </section>
  </div>
}
