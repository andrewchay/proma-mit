/**
 * 订阅门控空态：未订阅领域包时显示的占位 + 订阅引导
 */
import type * as React from 'react'
import { Lock } from 'lucide-react'
import { useSetAtom } from 'jotai'
import { activeViewAtom } from '@/atoms/active-view'

export function SubscriptionGate({ title, description }: { title: string; description: string }): React.ReactElement {
  const setActiveView = useSetAtom(activeViewAtom)

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex items-center justify-center h-12 w-12 rounded-2xl bg-foreground/[0.04]">
        <Lock size={20} className="text-foreground/35" />
      </div>
      <div className="text-[14px] font-medium text-foreground/80">{title}</div>
      <div className="text-[12px] text-foreground/45 max-w-[320px]">{description}</div>
      <button
        onClick={() => setActiveView('capabilities')}
        className="mt-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium"
      >
        前往应用中心订阅
      </button>
    </div>
  )
}

export default SubscriptionGate
