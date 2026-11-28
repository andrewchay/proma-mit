/**
 * InfluencerOutreachPanel — 达人触达（建联闭环）
 *
 * P1 范围：零外部依赖的完整闭环
 *   选达人 → 生成话术 → 编辑 → 复制 → 记录触达状态
 *
 * 真实发送（微信 / 蒲公英）依赖本机环境（Quartz / cliclick / Chrome debug），
 * 在 P2 通过「依赖自检 + 一键安装」接入；本面板先保证流程可用。
 */
import * as React from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Trash2,
  User,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  KOLListItem,
  OutreachChannel,
  OutreachRecord,
  OutreachStatus,
} from '@gravitas/shared'
import type { OutreachStats } from '../../../main/lib/marketing/outreach-service'
import type {
  DependencyReport,
  InstallResult,
} from '../../../main/lib/marketing/outreach-deps-service'
import type {
  WechatSession,
  WechatMessage,
} from '../../../main/lib/marketing/wechat-readonly-service'
import type { BrandContext } from '../../../main/lib/marketing/outreach-brand-context'
import { useAtomValue } from 'jotai'
import { currentAgentWorkspaceIdAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'

const CHANNEL_LABELS: Record<OutreachChannel, string> = {
  copy: '复制话术',
  wechat: '微信',
  pgy: '蒲公英',
  email: '邮件',
}

const STATUS_LABELS: Record<OutreachStatus, string> = {
  pending: '待发送',
  sent: '已发送',
  replied: '已回复',
  rejected: '已拒绝',
  converted: '已成交',
}

const STATUS_STYLES: Record<OutreachStatus, string> = {
  pending: 'bg-foreground/[0.06] text-foreground/60',
  sent: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  replied: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  rejected: 'bg-red-500/10 text-red-600 dark:text-red-400',
  converted: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
}

/** 状态流转顺序（用于快捷推进） */
const STATUS_FLOW: OutreachStatus[] = ['pending', 'sent', 'replied', 'converted']

export function InfluencerOutreachPanel(): React.ReactElement {
  const [kols, setKols] = React.useState<KOLListItem[]>([])
  const [records, setRecords] = React.useState<OutreachRecord[]>([])
  const [stats, setStats] = React.useState<OutreachStats | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [draft, setDraft] = React.useState('')
  const [generating, setGenerating] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [deps, setDeps] = React.useState<DependencyReport | null>(null)
  const [depsOpen, setDepsOpen] = React.useState(false)
  const [installing, setInstalling] = React.useState<string | null>(null)
  const [installOutput, setInstallOutput] = React.useState<InstallResult | null>(null)

  // 微信只读：会话列表 + 对话
  const [sessions, setSessions] = React.useState<WechatSession[]>([])
  const [loadingSessions, setLoadingSessions] = React.useState(false)
  const [sessionsError, setSessionsError] = React.useState<{ text: string; kind?: string } | null>(null)
  const [activeContact, setActiveContact] = React.useState<string | null>(null)
  const [messages, setMessages] = React.useState<WechatMessage[]>([])
  const [loadingMessages, setLoadingMessages] = React.useState(false)
  const [draftMeta, setDraftMeta] = React.useState<{ stage: string; risk: 'low' | 'high'; note: string } | null>(null)
  const [brandCtx, setBrandCtx] = React.useState<BrandContext | null>(null)
  /** 当前达人本地历史总条数（含已折叠的） */
  const [historyTotal, setHistoryTotal] = React.useState(0)

  // 当前工作区（品牌侧信息从这里读）
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const workspaceSlug = workspaces.find((w) => w.id === currentWorkspaceId)?.slug ?? null

  /** 检测微信自动化依赖（每次展开都重新探测） */
  const checkDeps = React.useCallback(async () => {
    try {
      const report = await window.electronAPI.checkOutreachDeps()
      setDeps(report)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  React.useEffect(() => {
    if (depsOpen && !deps) {
      checkDeps().catch(console.error)
    }
  }, [depsOpen, deps, checkDeps])

  const handleInstall = async (dependencyId: string) => {
    setInstalling(dependencyId)
    setInstallOutput(null)
    try {
      const result = await window.electronAPI.installOutreachDep(dependencyId)
      setInstallOutput(result)
      if (result.success) {
        await checkDeps()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(null)
    }
  }

  const reload = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [kolList, recordList, statResult] = await Promise.all([
        window.electronAPI.listAllKOLs(),
        window.electronAPI.listOutreachRecords({ limit: 100 }),
        window.electronAPI.getOutreachStats(),
      ])
      setKols(kolList ?? [])
      setRecords(recordList ?? [])
      setStats(statResult ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    reload().catch(console.error)
  }, [reload])

  /** 拉取微信会话（只读） */
  const handleLoadSessions = async () => {
    setLoadingSessions(true)
    setError(null)
    setSessionsError(null)
    try {
      const result = await window.electronAPI.listWechatSessions()
      if (!result.success) {
        setSessionsError({ text: result.error ?? '读取失败', kind: result.errorKind })
        setSessions([])
      } else {
        setSessions(result.sessions ?? [])
      }
    } catch (err) {
      setSessionsError({ text: err instanceof Error ? err.message : String(err), kind: 'unknown' })
    } finally {
      setLoadingSessions(false)
    }
  }

  /** 选中微信会话 → 读取对话（OCR）+ 同步到本地历史 */
  const handlePickSession = async (name: string) => {
    setActiveContact(name)
    setDraft('')
    setDraftMeta(null)
    setLoadingMessages(true)
    setError(null)
    try {
      const result = await window.electronAPI.readWechatMessages(name, 12)
      if (!result.success) {
        setSessionsError({ text: result.error ?? '读取对话失败', kind: result.errorKind })
        setMessages([])
      } else {
        const fresh = result.messages ?? []
        setMessages(fresh)
        // OCR 只能读到可见的最近 N 条；落库后历史会累积，生成草稿时用完整历史
        if (fresh.length > 0) {
          await window.electronAPI.syncWechatConversation(name, fresh)
        }
        const convs = await window.electronAPI.listWechatConversations()
        setHistoryTotal(convs?.find((c) => c.contact === name)?.messageCount ?? fresh.length)
        // convs 仅用于取本条达人的条数，无需额外状态
      }
    } catch (err) {
      setSessionsError({ text: err instanceof Error ? err.message : String(err), kind: 'unknown' })
    } finally {
      setLoadingMessages(false)
    }
  }

  /** 刷新当前达人的历史条数（面板顶部展示，失败不阻断主流程） */
  const refreshHistoryTotal = React.useCallback(async (contact: string) => {
    try {
      const list = await window.electronAPI.listWechatConversations()
      setHistoryTotal(list?.find((c) => c.contact === contact)?.messageCount ?? 0)
    } catch {
      // 摘要失败不阻断主流程
    }
  }, [])

  /** 读取品牌侧信息配置状态 */
  React.useEffect(() => {
    if (!workspaceSlug) {
      setBrandCtx(null)
      return
    }
    window.electronAPI
      .getBrandContext(workspaceSlug)
      .then(setBrandCtx)
      .catch(() => setBrandCtx(null))
  }, [workspaceSlug])

  /** 生成回复草稿（只生成，不发送） */
  const handleGenerate = async () => {
    if (!activeContact) return
    setGenerating(true)
    setError(null)
    try {
      // 优先用本地历史（累积更多轮次）；历史为空时回退到本次 OCR 结果
      let contextMessages = messages
      try {
        const history = await window.electronAPI.getWechatHistory(activeContact, 50)
        if (history && history.length > 0) {
          contextMessages = history.map((m) => ({
            dir: m.direction,
            text: m.content,
            y: m.msgOrder,
          }))
        }
      } catch {
        // 历史读取失败就用 OCR 结果，不阻断
      }

      if (contextMessages.length === 0) {
        setError('没有可用的对话内容，请先读取微信会话')
        return
      }

      const result = await window.electronAPI.generateOutreachDraft({
        contact: activeContact,
        messages: contextMessages,
        workspaceSlug: workspaceSlug ?? undefined,
      })
      setDraft(result.reply)
      setDraftMeta({ stage: result.stage, risk: result.risk, note: result.note })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  const handleCopy = async () => {
    if (!draft.trim()) return
    try {
      await navigator.clipboard.writeText(draft)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      setError(`复制失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 清空该达人的本地对话历史（只删本地库，不动微信） */
  const handleClearHistory = async () => {
    if (!activeContact) return
    const ok = window.confirm(
      `确定清空「${activeContact}」的本地对话历史？\n\n只删除本应用保存的对话记录，不影响微信里的聊天。`,
    )
    if (!ok) return
    setError(null)
    try {
      await window.electronAPI.clearWechatHistory(activeContact)
      setMessages([])
      setDraft('')
      setDraftMeta(null)
      await refreshHistoryTotal(activeContact)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 记录一次触达（关联到达人库中同名记录，没有则只存名字） */
  const handleRecord = async (status: OutreachStatus) => {
    if (!activeContact || !draft.trim()) return
    setError(null)
    try {
      const matched = kols.find((k) => k.name === activeContact)
      await window.electronAPI.createOutreachRecord({
        kolId: matched?.id ?? null,
        kolName: activeContact,
        channel: 'copy',
        content: draft,
        status,
      })
      // 已回复：把这轮达人消息标记为处理过，下次生成草稿不再当成待回
      await window.electronAPI.markWechatReplied(activeContact)
      await refreshHistoryTotal(activeContact)
      await reload()
      setDraft('')
      setDraftMeta(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleStatusChange = async (record: OutreachRecord, status: OutreachStatus) => {
    setError(null)
    try {
      await window.electronAPI.updateOutreachRecord({ id: record.id, status })
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDelete = async (id: string) => {
    setError(null)
    try {
      await window.electronAPI.deleteOutreachRecord(id)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-[13px] text-foreground/50">
        <Loader2 size={14} className="animate-spin mr-2" />
        加载触达数据…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 指标卡 */}
      {stats && (
        <div className="grid grid-cols-4 gap-2">
          <StatCard label="总触达" value={String(stats.total)} />
          <StatCard label="待发送" value={String(stats.byStatus.pending)} />
          <StatCard label="已回复" value={String(stats.byStatus.replied + stats.byStatus.converted)} />
          <StatCard label="回复率" value={`${Math.round(stats.replyRate * 100)}%`} />
        </div>
      )}

      {error && (
        <div className="px-3 py-2 rounded-md bg-red-500/10 text-[11px] text-red-600 dark:text-red-400 break-words">
          {error}
        </div>
      )}

      {/* 微信自动化依赖（P2：自检 + 一键安装） */}
      <section className="rounded-xl bg-card shadow-sm">
        <button
          onClick={() => setDepsOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left"
        >
          <AlertTriangle size={13} className="text-amber-500/80" />
          <span className="text-[12px] font-medium text-foreground/75">微信自动化环境</span>
          <span className="text-[10px] text-foreground/40">
            {deps
              ? deps.allReady
                ? '已就绪'
                : `缺 ${deps.dependencies.filter((d) => !d.ready).length} 项`
              : '点击检测'}
          </span>
          <div className="flex-1" />
          <span className="text-[10px] text-foreground/35">{depsOpen ? '收起' : '展开'}</span>
        </button>

        {depsOpen && (
          <div className="px-3 pb-3 space-y-2 border-t border-border/40 pt-2">
            {!deps ? (
              <div className="flex items-center gap-1.5 text-[11px] text-foreground/50 py-2">
                <Loader2 size={11} className="animate-spin" />
                正在检测…
              </div>
            ) : !deps.supported ? (
              <p className="text-[11px] text-foreground/50">
                微信自动化仅支持 macOS。当前平台可继续使用「复制话术」渠道。
              </p>
            ) : (
              <>
                {deps.dependencies.map((dep) => (
                  <div key={dep.id} className="flex items-center gap-2">
                    {dep.ready ? (
                      <CheckCircle2 size={12} className="text-emerald-500 shrink-0" />
                    ) : (
                      <AlertTriangle size={12} className="text-amber-500 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] text-foreground/75">{dep.label}</div>
                      <div className="text-[10px] text-foreground/40">{dep.purpose}</div>
                    </div>
                    {!dep.ready && (
                      <button
                        onClick={() => handleInstall(dep.id)}
                        disabled={installing !== null}
                        className={cn(
                          'inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors shrink-0',
                          installing !== null
                            ? 'bg-foreground/[0.06] text-foreground/30 cursor-not-allowed'
                            : 'bg-primary/90 text-primary-foreground hover:opacity-90',
                        )}
                      >
                        {installing === dep.id ? (
                          <Loader2 size={10} className="animate-spin" />
                        ) : (
                          <Download size={10} />
                        )}
                        安装
                      </button>
                    )}
                  </div>
                ))}

                {installOutput && (
                  <pre
                    className={cn(
                      'mt-1 px-2 py-1.5 rounded text-[10px] leading-relaxed whitespace-pre-wrap break-all max-h-32 overflow-y-auto',
                      installOutput.success
                        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                        : 'bg-red-500/10 text-red-600 dark:text-red-400',
                    )}
                  >
                    {installOutput.output}
                  </pre>
                )}

                <div className="pt-1 space-y-0.5">
                  <div className="text-[10px] text-foreground/45">还需手动授予系统权限：</div>
                  {deps.manualPermissions.map((p) => (
                    <div key={p} className="text-[10px] text-foreground/35 pl-2">
                      · {p}
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => checkDeps().catch(console.error)}
                  className="text-[10px] text-foreground/45 hover:text-foreground/70 transition-colors"
                >
                  重新检测
                </button>
              </>
            )}
          </div>
        )}
      </section>

      {/* 微信对话（只读）→ 生成草稿 */}
      <section className="rounded-xl bg-card shadow-sm p-3 space-y-3">
        <div className="flex items-center gap-2">
          <MessageSquarePlus size={14} className="text-foreground/45" />
          <h4 className="text-[12px] font-semibold text-foreground/75">从微信对话起草</h4>
          <div className="flex-1" />
          <button
            onClick={handleLoadSessions}
            disabled={loadingSessions}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-foreground/55 hover:text-foreground/80 hover:bg-foreground/[0.06] transition-colors"
          >
            {loadingSessions ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            读取会话
          </button>
        </div>

        <p className="text-[11px] text-foreground/35 leading-relaxed">
          只读取对话并起草回复，<strong className="text-foreground/55">不会自动发送</strong>。
          复制后自己粘贴发送，避免发错人。
        </p>

        {/* 品牌侧信息配置状态：未配置时草稿会写占位符，必须让用户知道 */}
        {brandCtx && !brandCtx.configured && (
          <div className="px-2.5 py-2 rounded-md bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">
            品牌侧信息未配置，草稿里的品牌名/自称会用
            <code className="mx-1 px-1 rounded bg-foreground/10">【待补充】</code>
            占位。请编辑工作区
            <code className="mx-1 px-1 rounded bg-foreground/10">skills/ma-kol-outreach/SKILL.md</code>
            第一节。
          </div>
        )}

        {sessionsError && (
          <div className="px-2.5 py-2 rounded-md bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed whitespace-pre-wrap">
            {sessionsError.kind === 'window-too-small'
              ? '微信窗口太小。请把微信窗口拉大到至少 700x500 再读取。'
              : sessionsError.kind === 'not-running'
                ? '未找到微信窗口。请先打开并登录微信。'
                : sessionsError.text}
          </div>
        )}

        {/* 会话列表 */}
        {sessions.length > 0 && (
          <div className="space-y-1 max-h-52 overflow-y-auto">
            {sessions.map((s) => (
              <button
                key={`${s.name}-${s.y}`}
                onClick={() => handlePickSession(s.name)}
                disabled={loadingMessages}
                className={cn(
                  'w-full text-left px-2.5 py-1.5 rounded-md transition-colors',
                  activeContact === s.name
                    ? 'bg-primary/10 text-foreground/85'
                    : 'hover:bg-foreground/[0.05] text-foreground/70',
                )}
              >
                <div className="text-[12px] font-medium truncate">{s.name}</div>
                {s.preview && (
                  <div className="text-[10px] text-foreground/40 truncate">{s.preview}</div>
                )}
              </button>
            ))}
          </div>
        )}

        {/* 对话内容 */}
        {activeContact && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <div className="text-[11px] text-foreground/50">
                最近对话 · {activeContact}
                {historyTotal > 0 && (
                  <span className="text-foreground/30 ml-1">（本地共 {historyTotal} 条）</span>
                )}
              </div>
              <div className="flex-1" />
              <button
                onClick={handleClearHistory}
                className="text-[10px] text-foreground/35 hover:text-red-500 transition-colors"
                title="清空该达人的本地对话历史（不影响微信）"
              >
                清空历史
              </button>
            </div>
            {loadingMessages ? (
              <div className="flex items-center gap-1.5 text-[11px] text-foreground/45 py-2">
                <Loader2 size={11} className="animate-spin" />
                读取中…
              </div>
            ) : messages.length === 0 ? (
              <p className="text-[11px] text-foreground/40">未读到消息</p>
            ) : (
              <div className="max-h-44 overflow-y-auto space-y-1 px-2.5 py-2 rounded-md bg-foreground/[0.03]">
                {messages.map((m, i) => (
                  <div
                    key={`${i}-${m.y}`}
                    className={cn(
                      'text-[11px] leading-relaxed break-words',
                      m.dir === 'out' ? 'text-foreground/45 text-right' : 'text-foreground/75',
                    )}
                  >
                    <span className="text-[9px] opacity-60 mr-1">
                      {m.dir === 'out' ? '我方' : '达人'}
                    </span>
                    {m.text}
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={handleGenerate}
              disabled={generating || messages.length === 0}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors',
                generating || messages.length === 0
                  ? 'bg-foreground/[0.06] text-foreground/30 cursor-not-allowed'
                  : 'bg-primary text-primary-foreground hover:opacity-90',
              )}
            >
              {generating ? <Loader2 size={12} className="animate-spin" /> : <User size={12} />}
              生成回复草稿
            </button>
          </div>
        )}

        {/* 草稿 */}
        {draft && (
          <>
            {draftMeta && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-1.5 py-0.5 rounded text-[10px] bg-foreground/[0.06] text-foreground/60">
                  {draftMeta.stage}
                </span>
                <span
                  className={cn(
                    'px-1.5 py-0.5 rounded text-[10px]',
                    draftMeta.risk === 'low'
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
                  )}
                >
                  {draftMeta.risk === 'low' ? '低风险' : '需人工确认'}
                </span>
                {draftMeta.note && (
                  <span className="text-[10px] text-foreground/40 flex-1 min-w-0 truncate">
                    {draftMeta.note}
                  </span>
                )}
              </div>
            )}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              className="w-full px-2.5 py-2 rounded-md bg-foreground/[0.04] text-[12px] leading-relaxed text-foreground/80 outline-none focus:ring-1 focus:ring-primary/40 resize-y"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/90 text-[12px] text-primary-foreground hover:opacity-90 transition-colors"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? '已复制' : '复制'}
              </button>
              <button
                onClick={() => handleRecord('sent')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-foreground/[0.06] text-[12px] text-foreground/70 hover:bg-foreground/[0.1] transition-colors"
              >
                <Send size={12} />
                记录已发送
              </button>
            </div>
          </>
        )}
      </section>

      {/* 触达记录 */}
      <section className="space-y-2">
        <h4 className="text-[12px] font-semibold text-foreground/75">
          触达记录 <span className="text-foreground/40 font-normal">({records.length})</span>
        </h4>
        {records.length === 0 ? (
          <p className="text-[11px] text-foreground/40 py-4 text-center">暂无触达记录</p>
        ) : (
          <div className="space-y-1.5">
            {records.map((record) => (
              <OutreachRecordRow
                key={record.id}
                record={record}
                onStatusChange={handleStatusChange}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="rounded-lg bg-card shadow-sm px-2.5 py-2">
      <div className="text-[10px] text-foreground/45">{label}</div>
      <div className="text-[16px] font-semibold text-foreground/85 tabular-nums">{value}</div>
    </div>
  )
}

function OutreachRecordRow({
  record,
  onStatusChange,
  onDelete,
}: {
  record: OutreachRecord
  onStatusChange: (record: OutreachRecord, status: OutreachStatus) => void
  onDelete: (id: string) => void
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const nextIndex = STATUS_FLOW.indexOf(record.status)
  const nextStatus = nextIndex >= 0 && nextIndex < STATUS_FLOW.length - 1 ? STATUS_FLOW[nextIndex + 1] : null

  return (
    <div className="rounded-lg bg-card shadow-sm px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-foreground/80">{record.kolName}</span>
        <span className={cn('px-1.5 py-0.5 rounded text-[10px]', STATUS_STYLES[record.status])}>
          {STATUS_LABELS[record.status]}
        </span>
        <span className="text-[10px] text-foreground/35">{CHANNEL_LABELS[record.channel]}</span>
        <div className="flex-1" />
        <span className="text-[10px] text-foreground/30 tabular-nums">
          {new Date(record.createdAt).toLocaleDateString('zh-CN')}
        </span>
      </div>

      {expanded && (
        <p className="text-[11px] leading-relaxed text-foreground/60 whitespace-pre-wrap break-words">
          {record.content}
        </p>
      )}

      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] text-foreground/45 hover:text-foreground/70 transition-colors"
        >
          {expanded ? '收起' : '查看话术'}
        </button>
        <div className="flex-1" />
        {nextStatus && (
          <button
            onClick={() => onStatusChange(record, nextStatus)}
            className="text-[10px] text-primary/70 hover:text-primary transition-colors"
          >
            → {STATUS_LABELS[nextStatus]}
          </button>
        )}
        <button
          onClick={() => onDelete(record.id)}
          className="p-0.5 text-foreground/25 hover:text-red-500 transition-colors"
          title="删除"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  )
}

