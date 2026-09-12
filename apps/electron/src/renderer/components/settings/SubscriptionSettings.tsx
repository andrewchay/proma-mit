import * as React from 'react'
import { useAtom } from 'jotai'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { SettingsRow } from './primitives/SettingsRow'
import { subscriptionStateAtom } from '@/atoms/subscription-atoms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function SubscriptionSettings(): React.ReactElement {
  const [state, setState] = useAtom(subscriptionStateAtom)
  const [phone, setPhone] = React.useState('')
  const [displayName, setDisplayName] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const handleLogin = async (): Promise<void> => {
    if (!phone.trim()) {
      setError('请输入手机号')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.loginSubscription({ phone: phone.trim(), displayName: displayName.trim() || undefined })
      setState(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = async (): Promise<void> => {
    setLoading(true)
    try {
      await window.electronAPI.logoutSubscription()
      setState({ entitlement: null, status: 'none' })
    } catch (err) {
      setError(err instanceof Error ? err.message : '登出失败')
    } finally {
      setLoading(false)
    }
  }

  const handleRefresh = async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await window.electronAPI.refreshSubscription()
      setState(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : '刷新失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="订阅与账户" description="管理你的账号、套餐与权益">
        <SettingsCard>
          {state.entitlement ? (
            <>
              <SettingsRow label="账户" description={state.accountId ?? '已登录'}>
                <Button variant="outline" size="sm" onClick={handleLogout} disabled={loading}>
                  退出登录
                </Button>
              </SettingsRow>
              <SettingsRow label="当前套餐" description={state.entitlement.planId === 'pro' ? '专业版' : '免费版'}>
                <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
                  刷新权益
                </Button>
              </SettingsRow>
              <SettingsRow
                label="权益状态"
                description={
                  state.status === 'active'
                    ? '生效中'
                    : state.status === 'grace'
                      ? '宽限期'
                      : state.status === 'expired'
                        ? '已过期'
                        : '未订阅'
                }
              />
              {state.entitlement.validUntil && (
                <SettingsRow label="有效期至" description={new Date(state.entitlement.validUntil).toLocaleString()} />
              )}
            </>
          ) : (
            <>
              <SettingsRow label="手机号" description="用于登录订阅账号">
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="13800000000"
                  className="w-48"
                />
              </SettingsRow>
              <SettingsRow label="昵称" description="可选">
                <Input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="你的昵称"
                  className="w-48"
                />
              </SettingsRow>
              {error && <div className="text-sm text-destructive px-4 pb-2">{error}</div>}
              <div className="px-4 pb-4">
                <Button onClick={handleLogin} disabled={loading}>
                  {loading ? '登录中...' : '登录 / 注册'}
                </Button>
              </div>
            </>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="升级专业版" description="解锁营销领域全部能力包">
        <SettingsCard>
          <SettingsRow
            label="专业版"
            description="包含 influencer、paid-media、outbound-sourcing 全部能力"
          >
            <Button
              size="sm"
              onClick={async () => {
                setLoading(true)
                setError(null)
                try {
                  await window.electronAPI.createSubscriptionCheckout({ planId: 'pro', provider: 'wechat-pay', period: 'monthly' })
                  await handleRefresh()
                } catch (err) {
                  setError(err instanceof Error ? err.message : '创建订单失败')
                } finally {
                  setLoading(false)
                }
              }}
              disabled={loading || !state.entitlement}
            >
              微信支付
            </Button>
          </SettingsRow>
          <SettingsRow
            label="专业版（年付）"
            description="按年订阅，价格更优惠"
          >
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                setLoading(true)
                setError(null)
                try {
                  await window.electronAPI.createSubscriptionCheckout({ planId: 'pro', provider: 'alipay', period: 'yearly' })
                  await handleRefresh()
                } catch (err) {
                  setError(err instanceof Error ? err.message : '创建订单失败')
                } finally {
                  setLoading(false)
                }
              }}
              disabled={loading || !state.entitlement}
            >
              支付宝
            </Button>
          </SettingsRow>
          {error && <div className="text-sm text-destructive px-4 pb-4">{error}</div>}
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
