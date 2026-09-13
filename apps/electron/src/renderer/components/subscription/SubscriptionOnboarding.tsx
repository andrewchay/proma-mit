/**
 * 订阅引导面板
 *
 * 用途：在首次启动引导与设置页中复用同一套订阅说明与登录入口。
 *
 * 设计取舍：
 * - 引导流程中登录是**可跳过**的。强制登录会显著提高首次使用的流失，
 *   而免费版本身可用，因此这里只做说明与入口，不做拦截。
 * - 服务地址未配置时明确提示，而不是让用户面对一个必然失败的登录表单。
 *   分发场景下这是最常见的问题来源。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Check, Mail, KeyRound, AlertTriangle, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { subscriptionStateAtom } from '@/atoms/subscription-atoms'

/** 免费版与专业版的差异说明，供引导页与设置页共享 */
export const PLAN_FEATURES = {
  free: [
    '通用 Agent 对话与工具调用',
    '项目管理与工作流',
    '本地记忆与技能系统',
  ],
  pro: [
    '达人 influencer 领域包',
    '广告投放 paid-media 领域包',
    '出海 sourcing 领域包',
    '全部领域技能与工具注入',
  ],
} as const

export interface SubscriptionOnboardingProps {
  /** 登录成功回调 */
  onLoggedIn?: () => void
  /** 紧凑模式：用于设置页内嵌 */
  compact?: boolean
}

type Step = 'intro' | 'email' | 'code'

export function SubscriptionOnboarding({
  onLoggedIn,
  compact = false,
}: SubscriptionOnboardingProps): React.ReactElement {
  const [state, setState] = useAtom(subscriptionStateAtom)
  const [step, setStep] = React.useState<Step>('intro')
  const [email, setEmail] = React.useState('')
  const [code, setCode] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [endpoint, setEndpoint] = React.useState<string | null>(null)

  React.useEffect(() => {
    void (async () => {
      try {
        const result = await window.electronAPI.getSubscriptionEndpoint()
        setEndpoint(result.url ?? null)
      } catch {
        setEndpoint(null)
      }
    })()
  }, [])

  const endpointMissing = endpoint === null

  const handleRequestCode = async (): Promise<void> => {
    const target = email.trim()
    if (!target) {
      setError('请输入邮箱')
      return
    }
    setLoading(true)
    setError(null)
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

  const handleVerify = async (): Promise<void> => {
    const value = code.trim()
    if (!value) {
      setError('请输入验证码')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.verifySubscriptionEmailCode({
        email: email.trim(),
        code: value,
      })
      setState(result)
      setNotice(null)
      onLoggedIn?.()
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
      window.open(authorizeUrl, '_blank')
      setNotice('已打开浏览器授权页，完成后返回并点击「刷新权益」')
    } catch (err) {
      setError(err instanceof Error ? err.message : '第三方登录不可用')
    } finally {
      setLoading(false)
    }
  }

  const isPro = state.entitlement?.planId === 'pro'

  return (
    <div className={compact ? 'space-y-4' : 'w-full max-w-2xl'}>
      {step === 'intro' && (
        <>
          <div className={compact ? 'mb-3' : 'mb-6 text-center'}>
            <h2 className={compact ? 'text-base font-semibold mb-1' : 'text-2xl font-semibold mb-2'}>
              选择适合你的版本
            </h2>
            <p className="text-sm text-muted-foreground">
              免费版可长期使用；专业版解锁全部领域能力包
            </p>
          </div>

          <div className={`grid gap-3 ${compact ? 'grid-cols-1' : 'grid-cols-2'}`}>
            <PlanCard
              title="免费版"
              highlight="长期可用"
              features={PLAN_FEATURES.free}
              active={!isPro}
            />
            <PlanCard
              title="专业版"
              highlight="¥68/月 或 ¥680/年"
              features={PLAN_FEATURES.pro}
              active={isPro}
              accent
            />
          </div>

          {endpointMissing && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <AlertTriangle size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="text-[12px] text-amber-700 dark:text-amber-500">
                尚未配置订阅服务地址，当前无法登录或订阅。
                可稍后在「设置 → 订阅与账户 → 服务地址」中填写。
              </div>
            </div>
          )}

          {endpointMissing ? (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={() => onLoggedIn?.()}>
                稍后设置
              </Button>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-border" />
                <span className="text-[11px] text-muted-foreground">使用邮箱登录</span>
                <div className="h-px flex-1 bg-border" />
              </div>

              <div className="flex gap-2">
                <Input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleRequestCode()
                  }}
                />
                <Button onClick={handleRequestCode} disabled={loading}>
                  {loading ? '发送中' : '获取验证码'}
                </Button>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => void handleOAuth('github')}
                  disabled={loading}
                >
                  GitHub 登录
                </Button>
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => void handleOAuth('google')}
                  disabled={loading}
                >
                  Google 登录
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {step === 'code' && (
        <>
          <div className="mb-4 text-center">
            <h2 className="text-xl font-semibold mb-1">输入验证码</h2>
            <p className="text-sm text-muted-foreground">已发送至 {email.trim()}</p>
          </div>

          <div className="flex justify-center gap-2">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6 位数字"
              className="w-40 text-center tracking-widest"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleVerify()
              }}
            />
            <Button onClick={handleVerify} disabled={loading}>
              {loading ? '校验中' : '登录'}
            </Button>
          </div>

          <div className="mt-4 flex justify-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleRequestCode} disabled={loading}>
              重新发送
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStep('intro')
                setCode('')
                setError(null)
                setNotice(null)
              }}
              disabled={loading}
            >
              换个邮箱
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => onLoggedIn?.()}
            >
              稍后再说
            </Button>
          </div>
        </>
      )}

      {notice && (
        <div className="mt-3 text-center text-[12px] text-muted-foreground">{notice}</div>
      )}
      {error && (
        <div className="mt-3 text-center text-[12px] text-destructive">{error}</div>
      )}
    </div>
  )
}

function PlanCard({
  title,
  highlight,
  features,
  active,
  accent = false,
}: {
  title: string
  highlight: string
  features: readonly string[]
  active?: boolean
  accent?: boolean
}): React.ReactElement {
  return (
    <div
      className={`rounded-xl border p-4 ${
        accent ? 'border-primary/30 bg-primary/[0.03]' : 'border-border/60'
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold flex items-center gap-1.5">
          {accent && <Sparkles size={14} className="text-primary" />}
          {title}
        </span>
        {active && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600">
            当前
          </span>
        )}
      </div>
      <div className="text-[11px] text-muted-foreground mb-3">{highlight}</div>
      <ul className="space-y-1.5">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-1.5 text-[12px]">
            <Check size={13} className="mt-0.5 flex-shrink-0 text-emerald-600" />
            <span className="text-foreground/75">{feature}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 供设置页复用的图标导出，避免重复引入 */
export const SubscriptionIcons = { Mail, KeyRound }
