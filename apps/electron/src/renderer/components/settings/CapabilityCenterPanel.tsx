/**
 * CapabilityCenterPanel — 能力中心 / 订阅面板
 *
 * 列出领域能力包（业务包 + 共享能力），支持订阅 / 取消订阅。
 * 订阅后才在侧边栏显示对应导航，并支持切换视图。
 */
import * as React from 'react'
import { useAtom } from 'jotai'
import { Users, Megaphone, ImageIcon, Check } from 'lucide-react'
import {
  CAPABILITY_MANIFEST,
  enabledCapabilitiesAtom,
  isCapabilityEnabled,
  toggleCapability,
  type CapabilityId,
  type CapabilityKind,
} from '@/atoms/marketing-atoms'

const KIND_META: Record<CapabilityKind, { label: string; desc: string }> = {
  business: { label: '业务领域包', desc: '独立订阅，启用后在侧边栏出现' },
  shared: { label: '共享能力', desc: '被业务包内嵌引用，随依赖自动启用' },
}

function CapabilityIcon({ kind }: { kind: CapabilityKind }): React.ReactNode {
  if (kind === 'shared') return <ImageIcon size={16} className="text-foreground/40" />
  return <Users size={16} className="text-foreground/40" />
}

export function CapabilityCenterPanel(): React.ReactElement {
  const [enabled, setEnabled] = useAtom(enabledCapabilitiesAtom)

  const handleToggle = (cap: (typeof CAPABILITY_MANIFEST)[number], ev: React.MouseEvent) => {
    ev.stopPropagation()
    if (cap.kind !== 'business') return
    setEnabled(toggleCapability(enabled, cap.id as CapabilityId))
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-medium text-foreground/85 mb-3">领域能力包</h3>
        <p className="text-[12px] text-foreground/50 mb-4">
          按需订阅加载，避免企业工作台被单一垂直域污染。订阅后才显示导航与视图。
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
                      </div>
                      {isBusiness && (
                        <div
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium ${
                            on ? 'bg-emerald-500/15 text-emerald-600' : 'bg-foreground/[0.05] text-foreground/50'
                          }`}
                        >
                          {on && <Check size={12} />}
                          {on ? '已订阅' : '未订阅'}
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
