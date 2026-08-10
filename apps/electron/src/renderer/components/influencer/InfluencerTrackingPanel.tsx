/**
 * InfluencerTrackingPanel — 达人内容追踪
 *
 * 达人内容数据追踪与效果记录。与 ma-publish-data-track skill 对应。
 * M2 为骨架：展示达人内容追踪统计（数据来源待接）。
 */
import * as React from 'react'
import { BarChart3, TrendingUp } from 'lucide-react'

export function InfluencerTrackingPanel(): React.ReactElement {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[13px] font-medium text-foreground/85">
        <BarChart3 size={14} className="text-foreground/45" />
        内容追踪
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: '待追踪', value: '—' },
          { label: '已发布', value: '—' },
          { label: '数据回填', value: '—' },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-border/50 p-3 text-center">
            <div className="text-lg font-semibold text-foreground/85">{s.value}</div>
            <div className="text-[11px] text-foreground/45">{s.label}</div>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border/30 p-4 text-[13px] text-foreground/45 flex items-center gap-2">
        <TrendingUp size={14} className="text-foreground/35" />
        达人内容数据追踪功能随 ma-publish-data-track skill 落地（对接飞书 Risk 追踪）。
      </div>
    </div>
  )
}

export default InfluencerTrackingPanel
