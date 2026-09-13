/**
 * OutboundSourcingModuleView — 出海 sourcing 领域工作台
 *
 * 从静态介绍升级为可开始工作的工作台：
 * - 顶部"开始工作"：填写产品与目标市场，一键创建 Agent 会话并预填提示词；
 * - 工作流入口：跳转 Workflow 面板使用已自动安装的 sourcing 流水线模板；
 * - 下方保留四阶段说明与能力边界（折叠区）。
 */
import * as React from 'react'
import { useSetAtom, useStore } from 'jotai'
import { Globe2, ListChecks, Mail, Play, Search, ShieldCheck, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { activeViewAtom } from '@/atoms/active-view'
import { appModeAtom } from '@/atoms/app-mode'
import { tabsAtom, activeTabIdAtom, openTab } from '@/atoms/tab-atoms'
import {
  agentSessionsAtom,
  currentAgentSessionIdAtom,
  agentChannelIdAtom,
  currentAgentWorkspaceIdAtom,
  agentPendingPromptAtom,
} from '@/atoms/agent-atoms'
import { InboxTab } from './InboxTab'
import { OutboxTab } from './OutboxTab'
import { OutreachMetricsCard } from './OutreachMetricsCard'

const stages = [
  { icon: Search, title: '1. 找买家', text: '输入产品、国家和买家类型，生成搜索计划；再用 Web Bridge 或外部资料补充候选公司。' },
  { icon: ShieldCheck, title: '2. 核验线索', text: '逐条核对官网、运营国家、品类匹配、联系人职位和邮箱来源，缺失证据标记为待核验。' },
  { icon: ListChecks, title: '3. 排优先级', text: '按国家一致性、业务匹配、邮箱与互动状态计算 P1/P2/P3，并保留理由。' },
  { icon: Mail, title: '4. 准备外联', text: '生成个性化首封邮件或回复草稿；发送前由人工确认收件人、事实与合规表述。' },
]

export function OutboundSourcingModuleView(): React.ReactElement {
  const store = useStore()
  const setActiveView = useSetAtom(activeViewAtom)
  const [product, setProduct] = React.useState('')
  const [market, setMarket] = React.useState('')
  const [starting, setStarting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  /** 创建 Agent 会话并预填提示词（复用快速任务的 pending prompt 链路） */
  const startSourcingSession = async (message: string, tabTitle: string): Promise<void> => {
    setStarting(true)
    setError(null)
    try {
      const channelId = store.get(agentChannelIdAtom) || undefined
      const workspaceId = store.get(currentAgentWorkspaceIdAtom) || undefined
      const meta = await window.electronAPI.createAgentSession(undefined, channelId, workspaceId)
      store.set(agentSessionsAtom, (prev) => [meta, ...prev])
      store.set(currentAgentSessionIdAtom, meta.id)

      const currentTabs = store.get(tabsAtom)
      const result = openTab(currentTabs, { type: 'agent', sessionId: meta.id, title: tabTitle.slice(0, 30) })
      store.set(tabsAtom, result.tabs)
      store.set(activeTabIdAtom, result.activeTabId)

      store.set(agentPendingPromptAtom, { sessionId: meta.id, message })
      store.set(appModeAtom, 'agent')
      setActiveView('conversations')
    } catch (err) {
      console.error('[出海sourcing] 创建会话失败:', err)
      setError(err instanceof Error ? err.message : '创建会话失败，请重试')
    } finally {
      setStarting(false)
    }
  }

  const handleQuickStart = (): void => {
    const p = product.trim()
    const m = market.trim()
    if (!p || !m) {
      setError('请先填写产品和目标市场')
      return
    }
    const message = [
      `请为「${p}」制定「${m}」市场的买家 sourcing 计划：`,
      '1. 先用 sourcing_build_keyword_plan 生成检索关键词与核验清单；',
      '2. 用 sourcing_search_buyers 检索候选买家公司（带来源链接）；对重点候选用 sourcing_verify_company 抓官网取证，证据不足的标记"待核验"；',
      '3. 用 sourcing_score_lead 对候选公司评分（P1/P2/P3）并保留理由；',
      '4. 对 P1/P2 用 sourcing_build_persona 合成决策人画像，再用 sourcing_draft_outreach 生成个性化外联草稿；',
      '5. 进度用 sourcing_outreach_metrics 查看；发送一律用 sourcing_queue_email 入队，我会在待发队列逐封确认。',
      '全程不把候选公司当成已验证事实。',
    ].join('\n')
    void startSourcingSession(message, `sourcing ${p} ${m}`)
  }

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
              <p className="mt-1 text-sm leading-6 text-foreground/60">把海外买家发现、线索核验、优先级判断、外联准备和邮件收发收敛成一条可复用的 Agent 工作链。</p>
            </div>
          </div>
        </div>

        <Tabs defaultValue="work">
          <TabsList>
            <TabsTrigger value="work">开始工作</TabsTrigger>
            <TabsTrigger value="inbox">收件箱</TabsTrigger>
            <TabsTrigger value="outbox">待发队列</TabsTrigger>
          </TabsList>
          <TabsContent value="work" className="mt-4 space-y-6">

        <OutreachMetricsCard />

        {/* 开始工作：填写 Brief 后一键进入 Agent */}
        <div className="rounded-xl bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground/85">
            <Play size={16} className="text-sky-600" />
            开始一次 sourcing
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              value={product}
              onChange={(e) => setProduct(e.target.value)}
              placeholder="产品，如 goji puree"
              className="flex-1"
            />
            <Input
              value={market}
              onChange={(e) => setMarket(e.target.value)}
              placeholder="目标市场，如 Germany"
              className="flex-1"
            />
            <Button onClick={() => void handleQuickStart()} disabled={starting} className="sm:w-32">
              {starting ? '创建中…' : '开始工作'}
            </Button>
          </div>
          {error && <div className="mt-2 text-[12px] text-amber-600">{error}</div>}
          <p className="mt-2 text-[12px] text-foreground/45">
            将创建新的 Agent 会话并自动注入四阶段工作指令；结果沉淀在会话中，随时可以继续追问。
          </p>
          <div className="mt-3 flex items-center gap-2 border-t border-border/40 pt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setActiveView('workflow')}
              className="gap-1.5"
            >
              <Workflow size={14} />
              打开 Sourcing 流水线工作流
            </Button>
            <span className="text-[12px] text-foreground/45">订阅后已自动安装到当前工作区，可直接创建 Run。</span>
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

          </TabsContent>
          <TabsContent value="inbox" className="mt-4">
            <InboxTab />
          </TabsContent>
          <TabsContent value="outbox" className="mt-4">
            <OutboxTab />
          </TabsContent>
        </Tabs>

        <details className="rounded-xl bg-amber-500/10 p-4 text-xs leading-5 text-foreground/65">
          <summary className="cursor-pointer select-none font-medium text-foreground/70">能力边界</summary>
          <p className="mt-2">
            领域包提供 <code>sourcing_build_keyword_plan</code>、<code>sourcing_search_buyers</code>（联网检索候选与来源）、<code>sourcing_verify_company</code>（官网证据核验）、<code>sourcing_score_lead</code>、<code>sourcing_build_persona</code>（画像假设）、<code>sourcing_draft_outreach</code>、<code>sourcing_draft_reply</code>、<code>sourcing_list_inbox</code>、<code>sourcing_queue_email</code> 与 <code>sourcing_outreach_metrics</code>（漏斗指标）。邮件发送为审批制：只会在"待发队列"中经你逐封确认后发出，Agent 永远不能直接发送；检索与核验只提供证据，候选公司不作为已验证事实。
          </p>
        </details>
      </div>
    </div>
  )
}

export default OutboundSourcingModuleView
