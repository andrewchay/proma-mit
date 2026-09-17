import * as React from 'react'
import { AlertTriangle, CheckCircle2, CircleSlash, KeyRound, RefreshCw } from 'lucide-react'
import type { WechatDirectAccountProfile, WechatDirectCapabilityState } from '@gravitas/shared'

const REASON_LABEL: Record<WechatDirectCapabilityState['reason'], string> = {
  enabled: '已启用',
  no_credential: '未配置凭据',
  not_connected: '未通过微信侧校验',
  account_type_not_allowed: '账号类型不支持',
  verification_required: '需要微信认证',
  scope_not_granted: '缺少平台权限',
  ip_whitelist_required: '需要 IP 白名单',
}

const ACCOUNT_TYPE_LABEL: Record<WechatDirectAccountProfile['accountType'], string> = {
  subscription: '订阅号',
  service: '服务号',
  test: '测试号',
}

/**
 * 微信公众号连接向导与权限矩阵。
 *
 * 两件必须如实说明的事：
 * 1. AppSecret 属于 client secret，按项目约束不得经渲染进程输入；
 *    因此这里只呈现凭据状态与录入要求，不提供明文输入框。
 * 2. 微信不返回接口权限清单，权限只能由真实接口调用观察得到；
 *    因此「缺少平台权限」是默认状态，而不是异常。
 */
export function WechatConnectionGuide({
  accountId,
  profile,
  capabilities,
  credentialProtection,
  status,
  onRefresh,
}: {
  accountId: string
  profile: WechatDirectAccountProfile | null
  capabilities: WechatDirectCapabilityState[]
  credentialProtection: string
  status: string
  onRefresh: () => Promise<void>
}): React.ReactElement {
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const gaps = React.useMemo(() => {
    const problems: string[] = []
    if (credentialProtection === 'none') problems.push('尚未配置 AppID / AppSecret，无法调用微信接口。')
    if (credentialProtection === 'degraded') problems.push('系统安全存储不可用，凭据以降级方式保存；请修复系统钥匙串后重新录入。')
    if (profile && profile.verificationStatus !== 'verified') problems.push('账号未完成微信认证，草稿与发布接口会被平台拒绝。')
    if (profile && !profile.ipWhitelistConfigured) problems.push('尚未在微信后台把出口 IP 加入白名单，接口调用会返回 40164。')
    if (status !== 'connected' && credentialProtection !== 'none') problems.push('凭据尚未通过微信侧校验，当前不会调用任何接口。')
    return problems
  }, [credentialProtection, profile, status])

  const missingScopes = React.useMemo(() => {
    const set = new Set<string>()
    for (const item of capabilities) {
      if (item.reason === 'scope_not_granted') for (const scope of item.requiredScopes) set.add(scope)
    }
    return [...set].sort()
  }, [capabilities])

  const connect = async (): Promise<void> => {
    setBusy(true)
    setNotice('')
    try {
      const connected = await window.electronAPI.paa.newMedia.accounts.connect(accountId)
      setNotice(connected.status === 'connected' ? '凭据已通过 stable token 校验。' : `连接结果：${connected.status}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '连接失败')
    } finally {
      setBusy(false)
      await onRefresh()
    }
  }

  return <div className="mt-3 space-y-3 border-t border-border/40 pt-3">
    <div>
      <div className="text-xs font-medium">连接状态</div>
      <div className="mt-1 grid grid-cols-2 gap-1 text-xs text-foreground/60">
        <span>AppID：{profile?.appId || '未配置'}</span>
        <span>账号类型：{profile ? ACCOUNT_TYPE_LABEL[profile.accountType] : '未知'}</span>
        <span>微信认证：{profile ? (profile.verificationStatus === 'verified' ? '已认证' : '未认证') : '未知'}</span>
        <span>IP 白名单：{profile ? (profile.ipWhitelistConfigured ? '已配置' : '未配置') : '未知'}</span>
        <span>凭据保护：{credentialProtection === 'none' ? '无凭据' : credentialProtection === 'encrypted' ? '已加密' : '降级（未加密）'}</span>
        <span>Token 过期：{profile?.stableTokenExpiresAt ? new Date(profile.stableTokenExpiresAt).toLocaleString('zh-CN') : '未知'}</span>
      </div>
    </div>

    {gaps.length > 0 && <div className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
      <div className="flex items-center gap-1 font-medium"><AlertTriangle size={12} />待解决事项</div>
      <ul className="mt-1 space-y-0.5">{gaps.map((gap) => <li key={gap}>· {gap}</li>)}</ul>
    </div>}

    <div className="rounded-lg bg-muted/50 p-2 text-xs text-foreground/60">
      <div className="flex items-center gap-1 font-medium"><KeyRound size={12} />凭据录入方式</div>
      <p className="mt-1">AppSecret 属于客户端密钥，不会经过界面或 IPC 传输；录入必须在主进程安全通道完成（尚未实现）。当前版本在此只展示凭据状态，不提供明文输入框。</p>
    </div>

    <div>
      <div className="text-xs font-medium">接口权限矩阵</div>
      <p className="mt-1 text-[11px] text-foreground/50">微信不返回权限清单，权限只能由真实接口调用结果观察；因此「缺少平台权限」是默认状态，不代表账号异常。</p>
      <div className="mt-1 space-y-1">
        {capabilities.map((item) => <div key={item.capability} className="flex items-start justify-between gap-2 rounded-lg bg-muted/40 px-2 py-1.5 text-xs">
          <div>
            <div className="flex items-center gap-1">
              {item.enabled ? <CheckCircle2 size={12} className="text-emerald-600" /> : <CircleSlash size={12} className="text-foreground/40" />}
              <span>{item.label}</span>
              {item.externalSideEffect && <span className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-300">对外可见</span>}
            </div>
            <div className="mt-0.5 text-[11px] text-foreground/50">{REASON_LABEL[item.reason]} · 需要权限 {item.requiredScopes.join('、')}{item.reason !== 'enabled' ? ` · ${item.explanation}` : ''}</div>
          </div>
        </div>)}
        {capabilities.length === 0 && <div className="text-xs text-foreground/45">尚未进行能力协商（需先配置凭据）</div>}
      </div>
    </div>

    {missingScopes.length > 0 && <div className="text-[11px] text-foreground/50">需要在微信后台开通的接口权限：{missingScopes.join('、')}</div>}

    {notice && <div className="rounded-lg bg-muted p-2 text-xs text-foreground/70">{notice}</div>}

    <div className="flex justify-end gap-2">
      <button disabled={busy || credentialProtection === 'none'} onClick={() => void connect()} className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50">
        {busy ? <RefreshCw size={12} className="animate-spin" /> : null}用 stable token 校验凭据
      </button>
    </div>
  </div>
}
