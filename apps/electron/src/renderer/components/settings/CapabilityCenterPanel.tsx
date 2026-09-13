/**
 * CapabilityCenterPanel — 专业订阅服务 / 订阅面板
 *
 * 列出领域能力包（业务包 + 共享能力），支持订阅 / 取消订阅。
 * 订阅后才在侧边栏显示对应导航，并支持切换视图。
 */
import type * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Users, Megaphone, ImageIcon, Globe2, Check, Crown, UserRound } from 'lucide-react'
import {
  CAPABILITY_MANIFEST,
  enabledCapabilitiesAtom,
  activeCapabilitiesAtom,
  isCapabilityEnabled,
  toggleCapability,
  persistMarketingCapabilities,
  type CapabilityId,
  type CapabilityKind,
} from '@/atoms/marketing-atoms'
import { subscriptionStateAtom } from '@/atoms/subscription-atoms'

const KIND_META: Record<CapabilityKind, { label: string; desc: string }> = {
  business: { label: '业务领域包', desc: '随专业版订阅解锁，启用后在侧边栏出现对应工作入口' },
  shared: { label: '共享能力', desc: '被业务包内嵌引用，随依赖自动启用' },
}

function CapabilityIcon({ kind, id }: { kind: CapabilityKind; id?: string }): React.ReactNode {
  if (kind === 'shared') return <ImageIcon size={16} className="text-foreground/40" />
  if (id === 'outbound-sourcing') return <Globe2 size={16} className="text-foreground/40" />
  return <Users size={16} className="text-foreground/40" />
}

export function CapabilityCenterPanel(): React.ReactElement {
  const [enabled, setEnabled] = useAtom(enabledCapabilitiesAtom)
  // 实际可用能力由订阅权益决定；本地开关只是偏好
  const active = useAtomValue(activeCapabilitiesAtom)
  const subscriptionState = useAtomValue(subscriptionStateAtom)
  const hasEntitlement = Boolean(subscriptionState.entitlement)
  const isPro = subscriptionState.entitlement?.planId === 'pro'
  const account = subscriptionState.accountId ?? null

  const handleToggle = (cap: (typeof CAPABILITY_MANIFEST)[number], ev: React.MouseEvent) => {
    ev.stopPropagation()
    if (cap.kind !== 'business') return
    const next = toggleCapability(enabled, cap.id as CapabilityId)
    setEnabled(next)
    // 持久化到 main settings.json，使营销工具/指令的注入随订阅联动
    void persistMarketingCapabilities(next)
  }

  return (
    <div className="space-y-5">
      {/* 套餐状态置顶：先让用户知道自己在哪个档位，再看能力包 */}
      <div className="flex items-center gap-4 rounded-xl bg-gradient-to-br from-amber-500/10 via-background to-foreground/[0.03] p-4 shadow-sm">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600">
          <Crown size={19} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] font-medium text-foreground/85">
            专业订阅服务
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                isPro ? 'bg-amber-500/15 text-amber-600' : 'bg-foreground/[0.06] text-foreground/55'
              }`}
            >
              {isPro ? '专业版' : '免费版'}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-foreground/50">
            <UserRound size={13} />
            {account ? `已登录：${account}` : '未登录订阅账号'}
            {!isPro && '；订阅专业版后可解锁下方全部领域包'}
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium text-foreground/85 mb-3">领域能力包</h3>
        <p className="text-[12px] text-foreground/50 mb-4">
          领域能力包为 Agent 注入领域工具、技能与工作流。此处开关控制是否在侧边栏显示对应工作入口；实际可用需订阅专业版。
        </p>

        {Object.entries(KIND_META).map(([kind, meta]) => {
          const items = CAPABILITY_MANIFEST.filter((c) => c.kind === kind)
          if (items.length === 0) return null
          return (
            <div key={kind} className="mb-4">
              <div className="text-[12px] font-medium text-foreground/60 mb-2">{meta.label}</div>
              <div className="space-y-2">
                {items.map((cap) => {
                  const isBusiness = cap.kind === 'business'
                  const on = isBusiness && isCapabilityEnabled(enabled, cap.id as CapabilityId)
                  const usable = isBusiness && active.includes(cap.id as CapabilityId)
                  // 已开启但无权益：需要引导订阅，而不是静默不可用
                  const lockedByEntitlement = on && !usable
                  return (
                    <div
                      key={cap.id}
                      onClick={(ev) => handleToggle(cap, ev)}
                      className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                        isBusiness ? 'cursor-pointer hover:bg-foreground/[0.03]' : ''
                      } border-border/50`}
                    >
                      <div className="flex items-center justify-center h-9 w-9 rounded-lg bg-foreground/[0.04]">
                        {<CapabilityIcon kind={cap.kind} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-medium text-foreground/85">{cap.label}</span>
                          {cap.dependsOn?.map((d) => (
                            <span key={d} className="text-[10px] px-1.5 py-0.5 rounded bg-foreground/[0.05] text-foreground/50">
                              依赖 {d}
                            </span>
                          ))}
                        </div>
                        <div className="text-[12px] text-foreground/50 truncate">{cap.description}</div>
                        {lockedByEntitlement && (
                          <div className="text-[11px] text-amber-600 mt-0.5">
                            {hasEntitlement ? '当前套餐未包含此能力' : '需订阅专业版后可使用'}
                          </div>
                        )}
                      </div>
                      {isBusiness && (
                        <div
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium ${
                            usable
                              ? 'bg-emerald-500/15 text-emerald-600'
                              : on
                                ? 'bg-amber-500/15 text-amber-600'
                                : 'bg-foreground/[0.05] text-foreground/50'
                          }`}
                        >
                          {usable && <Check size={12} />}
                          {usable ? '可用' : on ? '待订阅' : '未开启'}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default CapabilityCenterPanel
