import * as React from 'react'
import { useAtom } from 'jotai'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { SettingsRow } from './primitives/SettingsRow'
import { subscriptionStateAtom } from '@/atoms/subscription-atoms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** 登录流程的两个阶段 */
type LoginStep = 'email' | 'code'

export function SubscriptionSettings(): React.ReactElement {
  const [state, setState] = useAtom(subscriptionStateAtom)

  const [step, setStep] = React.useState<LoginStep>('email')
  const [email, setEmail] = React.useState('')
  const [code, setCode] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  // 服务地址配置。空字符串表示清除自定义，回退到构建期默认值。
  const [endpoint, setEndpoint] = React.useState('')
  const [endpointDraft, setEndpointDraft] = React.useState('')
  const [endpointLoading, setEndpointLoading] = React.useState(false)
  const [showEndpoint, setShowEndpoint] = React.useState(false)

  // 支付：保存二维码内容供用户扫码
  const [pendingOrder, setPendingOrder] = React.useState<{
    orderId: string
    qrCodeContent?: string
    provider: string
  } | null>(null)

  React.useEffect(() => {
    void (async () => {
      try {
        const result = await window.electronAPI.getSubscriptionEndpoint()
        setEndpoint(result.url ?? '')
        setEndpointDraft(result.url ?? '')
        // 未配置地址时直接展开配置区，避免用户面对不可用的登录表单
        if (!result.url) setShowEndpoint(true)
      } catch {
        // 读取失败不影响其余功能
      }
    })()
  }, [])

  const handleRequestCode = async (): Promise<void> => {
    const target = email.trim()
    if (!target) {
      setError('请输入邮箱')
      return
    }
    setLoading(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.electronAPI.requestSubscriptionEmailCode({ email: target })
      setStep('code')
      setNotice(`验证码已发送至 ${target}，${Math.floor(result.expiresInSeconds / 60)} 分钟内有效`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证码发送失败')
    } finally {
      setLoading(false)
    }
  }

  const handleVerifyCode = async (): Promise<void> => {
    const target = email.trim()
    const value = code.trim()
    if (!value) {
      setError('请输入验证码')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.verifySubscriptionEmailCode({
        email: target,
        code: value,
      })
      setState(result)
      setNotice(null)
      setCode('')
      setStep('email')
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证码校验失败')
    } finally {
      setLoading(false)
    }
  }

  const handleOAuth = async (provider: 'github' | 'google'): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const { authorizeUrl } = await window.electronAPI.startSubscriptionOAuth(provider)
      // 在系统浏览器中打开授权页，避免在应用窗口内加载第三方页面
      window.open(authorizeUrl, '_blank')
      setNotice('已在浏览器中打开授权页，完成授权后返回本页点击「刷新权益」')
    } catch (err) {
      setError(err instanceof Error ? err.message : '第三方登录不可用')
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = async (): Promise<void> => {
    setLoading(true)
    try {
      await window.electronAPI.logoutSubscription()
      setState({ entitlement: null, status: 'none', connectivity: 'unknown' })
      setEmail('')
      setCode('')
      setStep('email')
      setPendingOrder(null)
      setNotice(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登出失败')
    } finally {
      setLoading(false)
    }
  }

  const handleRefresh = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.refreshSubscription()
      setState(result)
      if (result.connectivity === 'offline') {
        setNotice('当前无法连接订阅服务，正在使用本地缓存的权益')
      } else {
        setNotice(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '刷新失败')
    } finally {
      setLoading(false)
    }
  }

  const handleSaveEndpoint = async (): Promise<void> => {
    setEndpointLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.setSubscriptionEndpoint(endpointDraft.trim())
      setEndpoint(result.url ?? '')
      setNotice(result.url ? '服务地址已保存' : '已清除自定义地址')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setEndpointLoading(false)
    }
  }

  /** 创建订单并展示二维码。支付结果由服务端回调确认，这里只负责展示与触发查单。 */
  const handleCreateCheckout = async (provider: 'wechat-pay' | 'alipay', period: 'monthly' | 'yearly'): Promise<void> => {
    setLoading(true)
    setError(null)
    setNotice(null)
    try {
      const order = await window.electronAPI.createSubscriptionCheckout({
        planId: 'pro',
        provider,
        period,
      })
      setPendingOrder({
        orderId: order.orderId,
        ...(order.qrCodeContent ? { qrCodeContent: order.qrCodeContent } : {}),
        provider: order.provider,
      })
      setNotice('请使用对应应用扫码完成支付。支付完成后点击「刷新权益」开通。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建订单失败')
    } finally {
      setLoading(false)
    }
  }

  /** 主动向渠道查单，用于回调丢失时同步状态 */
  const handleSyncOrder = async (): Promise<void> => {
    if (!pendingOrder) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.syncSubscriptionOrder(pendingOrder.orderId)
      if (result.awaitingCallback) {
        setNotice('渠道显示已支付，正在等待服务端确认并开通权益，请稍后点击「刷新权益」')
      } else if (result.channelPaid === false) {
        setNotice('尚未检测到支付，请完成扫码支付后重试')
      } else {
        setNotice('订单状态已同步')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '同步订单失败')
    } finally {
      setLoading(false)
    }
  }

  const statusText =
    state.status === 'active'
      ? '生效中'
      : state.status === 'grace'
        ? '宽限期'
        : state.status === 'expired'
          ? '已过期'
          : '未订阅'

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
              <SettingsRow
                label="当前套餐"
                description={state.entitlement.planId === 'pro' ? '专业版' : '免费版'}
              >
                <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
                  刷新权益
                </Button>
              </SettingsRow>
              <SettingsRow label="权益状态" description={statusText} />
              {state.entitlement.validUntil && (
                <SettingsRow
                  label="有效期至"
                  description={new Date(state.entitlement.validUntil).toLocaleString()}
                />
              )}
            </>
          ) : (
            <>
              {step === 'email' ? (
                <>
                  <SettingsRow label="邮箱" description="用于接收登录验证码">
                    <Input
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="w-56"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleRequestCode()
                      }}
                    />
                  </SettingsRow>
                  <div className="px-4 pb-4 flex gap-2">
                    <Button onClick={handleRequestCode} disabled={loading}>
                      {loading ? '发送中...' : '发送验证码'}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <SettingsRow label="验证码" description={`已发送至 ${email}`}>
                    <Input
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="6 位数字"
                      className="w-32"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleVerifyCode()
                      }}
                    />
                  </SettingsRow>
                  <div className="px-4 pb-4 flex gap-2">
                    <Button onClick={handleVerifyCode} disabled={loading}>
                      {loading ? '校验中...' : '登录'}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleRequestCode}
                      disabled={loading}
                    >
                      重新发送
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setStep('email')
                        setCode('')
                        setError(null)
                        setNotice(null)
                      }}
                      disabled={loading}
                    >
                      换个邮箱
                    </Button>
                  </div>
                </>
              )}

              <SettingsRow label="第三方登录" description="使用 GitHub 或 Google 账号">
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleOAuth('github')}
                    disabled={loading}
                  >
                    GitHub
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleOAuth('google')}
                    disabled={loading}
                  >
                    Google
                  </Button>
                </div>
              </SettingsRow>
            </>
          )}

          {notice && <div className="text-sm text-muted-foreground px-4 pb-2">{notice}</div>}
          {error && <div className="text-sm text-destructive px-4 pb-2">{error}</div>}
        </SettingsCard>
      </SettingsSection>

      {state.entitlement?.planId !== 'pro' && (
        <SettingsSection title="升级专业版" description="解锁营销领域全部能力包">
          <SettingsCard>
            <SettingsRow label="专业版（月付）" description="¥68/月，包含全部能力包">
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => void handleCreateCheckout('wechat-pay', 'monthly')}
                  disabled={loading || !state.entitlement}
                >
                  微信支付
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCreateCheckout('alipay', 'monthly')}
                  disabled={loading || !state.entitlement}
                >
                  支付宝
                </Button>
              </div>
            </SettingsRow>
            <SettingsRow label="专业版（年付）" description="¥680/年，比月付省 ¥136">
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => void handleCreateCheckout('wechat-pay', 'yearly')}
                  disabled={loading || !state.entitlement}
                >
                  微信支付
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCreateCheckout('alipay', 'yearly')}
                  disabled={loading || !state.entitlement}
                >
                  支付宝
                </Button>
              </div>
            </SettingsRow>

            {pendingOrder && (
              <div className="px-4 pb-4 space-y-3">
                {pendingOrder.qrCodeContent ? (
                  <div className="space-y-2">
                    <div className="text-sm text-muted-foreground">
                      请使用{pendingOrder.provider === 'wechat-pay' ? '微信' : '支付宝'}扫码支付
                    </div>
                    {/* 渠道返回的是二维码链接，交由用户自行生成二维码 */}
                    <code className="block text-xs break-all rounded bg-muted p-2">
                      {pendingOrder.qrCodeContent}
                    </code>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">订单已创建</div>
                )}
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleSyncOrder} disabled={loading}>
                    查询支付状态
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={loading}>
                    刷新权益
                  </Button>
                </div>
              </div>
            )}

            {!state.entitlement && (
              <div className="text-sm text-muted-foreground px-4 pb-4">
                请先登录账号后再订阅
              </div>
            )}
          </SettingsCard>
        </SettingsSection>
      )}

      <SettingsSection title="服务地址" description="订阅服务未配置时，付费功能不可用">
        <SettingsCard>
          <SettingsRow
            label="当前地址"
            description={endpoint || '未配置（付费功能不可用）'}
          >
            <Button variant="outline" size="sm" onClick={() => setShowEndpoint((v) => !v)}>
              {showEndpoint ? '收起' : '修改'}
            </Button>
          </SettingsRow>
          {showEndpoint && (
            <>
              <SettingsRow label="自定义地址" description="留空则使用默认地址">
                <Input
                  value={endpointDraft}
                  onChange={(e) => setEndpointDraft(e.target.value)}
                  placeholder="https://subscription.example.com"
                  className="w-72"
                />
              </SettingsRow>
              <div className="px-4 pb-4">
                <Button size="sm" onClick={handleSaveEndpoint} disabled={endpointLoading}>
                  {endpointLoading ? '保存中...' : '保存'}
                </Button>
              </div>
            </>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
