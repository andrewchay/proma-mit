import * as React from 'react'
import { Globe2, ListChecks, Mail, Search, ShieldCheck } from 'lucide-react'

const stages = [
  { icon: Search, title: '1. 找买家', text: '输入产品、国家和买家类型，生成搜索计划；再用 Web Bridge 或外部资料补充候选公司。' },
  { icon: ShieldCheck, title: '2. 核验线索', text: '逐条核对官网、运营国家、品类匹配、联系人职位和邮箱来源，缺失证据标记为待核验。' },
  { icon: ListChecks, title: '3. 排优先级', text: '按国家一致性、业务匹配、邮箱与互动状态计算 P1/P2/P3，并保留理由。' },
  { icon: Mail, title: '4. 准备外联', text: '生成个性化首封邮件或回复草稿；发送前由人工确认收件人、事实与合规表述。' },
]

export function OutboundSourcingModuleView(): React.ReactElement {
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="rounded-2xl bg-gradient-to-br from-sky-500/15 via-background to-emerald-500/10 p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-600">
              <Globe2 size={22} />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground/90">出海 sourcing</h1>
              <p className="mt-1 text-sm leading-6 text-foreground/60">把海外买家发现、线索核验、优先级判断和外联准备收敛成一条可复用的 Agent 工作链。</p>
            </div>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {stages.map(({ icon: Icon, title, text }) => (
            <div key={title} className="rounded-xl bg-card p-4 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground/85"><Icon size={17} className="text-sky-600" />{title}</div>
              <p className="mt-2 text-xs leading-5 text-foreground/55">{text}</p>
            </div>
          ))}
        </div>
        <div className="rounded-xl bg-amber-500/10 p-4 text-xs leading-5 text-foreground/65">
          在 Agent 中直接说“为 X 产品制定 Y 国买家 sourcing 计划”即可开始。领域包提供 <code>sourcing_build_keyword_plan</code>、<code>sourcing_score_lead</code> 和 <code>sourcing_draft_outreach</code>；不会自动发邮件，也不会把候选公司当成已验证事实。
        </div>
      </div>
    </div>
  )
}

export default OutboundSourcingModuleView
