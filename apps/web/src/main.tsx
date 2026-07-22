import { atom, useAtom } from 'jotai'
import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import './styles.css'

const apiBaseAtom = atom(import.meta.env.VITE_PROMA_API_BASE_URL ?? '')
const tokenAtom = atom('')

interface Session {
  sessionId: string
  title: string
  modelId: string
  workspaceSlug: string
  channelId: string
  archivedAt?: number
}

interface Message {
  uuid?: string
  type: 'user' | 'assistant'
  message?: { content?: Array<{ type?: string; text?: string }> }
}

interface Interaction {
  requestId: string
  kind: 'permission' | 'ask_user' | 'plan'
  version: number
  request: {
    description?: string
    toolName?: string
    toolInput?: { plan?: string }
    questions?: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }> }>
  }
}

interface McpStatus {
  serverName: string
  transport: string
  authType: string
  connected: boolean
}

interface AdminRecord { createdAt?: number; action?: string; result?: string; taskId?: string; traceId?: string }

function App(): JSX.Element {
  const [apiBase, setApiBase] = useAtom(apiBaseAtom)
  const [token, setToken] = useAtom(tokenAtom)
  const [sessions, setSessions] = useState<Session[]>([])
  const [selected, setSelected] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [stream, setStream] = useState<string[]>([])
  const [interactions, setInteractions] = useState<Interaction[]>([])
  const [mcpServers, setMcpServers] = useState<McpStatus[]>([])
  const [admin, setAdmin] = useState<unknown>()
  const [status, setStatus] = useState('等待连接')
  const [prompt, setPrompt] = useState('')
  const [sessionTitle, setSessionTitle] = useState('')
  const [sessionModel, setSessionModel] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [planFeedback, setPlanFeedback] = useState<Record<string, string>>({})
  const [auditAction, setAuditAction] = useState('')
  const lastEventId = useRef('')

  const request = useCallback(async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    if (token) headers.set('authorization', `Bearer ${token}`)
    return fetch(`${apiBase}${path}`, { ...init, headers })
  }, [apiBase, token])

  const loadSessions = useCallback(async (): Promise<void> => {
    const response = await request('/agent/sessions?archived=all')
    const body = await response.json() as { sessions?: Session[]; error?: string }
    if (!response.ok) { setStatus(body.error ?? `加载失败：${response.status}`); return }
    setSessions(body.sessions ?? [])
    setSelected((current) => current || body.sessions?.[0]?.sessionId || '')
    setStatus(`已加载 ${body.sessions?.length ?? 0} 个会话`)
  }, [request])

  const loadMessages = useCallback(async (): Promise<void> => {
    if (!selected) return
    const response = await request(`/agent/sessions/${encodeURIComponent(selected)}/messages`)
    if (!response.ok) return
    const body = await response.json() as { messages?: Message[] }
    setMessages(body.messages ?? [])
  }, [request, selected])

  const loadMcpStatus = useCallback(async (): Promise<void> => {
    const session = sessions.find((item) => item.sessionId === selected)
    if (!session) { setMcpServers([]); return }
    const response = await request(`/agent/workspaces/${encodeURIComponent(session.workspaceSlug)}/mcp`)
    if (!response.ok) { setMcpServers([]); return }
    const body = await response.json() as { servers?: McpStatus[] }
    setMcpServers(body.servers ?? [])
  }, [request, selected, sessions])

  useEffect(() => {
    const session = sessions.find((item) => item.sessionId === selected)
    setSessionTitle(session?.title ?? '')
    setSessionModel(session?.modelId ?? '')
    void loadMessages(); void loadMcpStatus(); lastEventId.current = ''
  }, [loadMessages, loadMcpStatus, selected, sessions])
  useEffect(() => { void loadSessions() }, [loadSessions])

  useEffect(() => {
    const controller = new AbortController()
    if (!selected) return () => controller.abort()
    const consume = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        try {
          const headers = new Headers(token ? { authorization: `Bearer ${token}` } : {})
          if (lastEventId.current) headers.set('last-event-id', lastEventId.current)
          const response = await fetch(`${apiBase}/agent/sessions/${encodeURIComponent(selected)}/events`, { headers, signal: controller.signal })
          if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`)
          const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''
          while (!controller.signal.aborted) {
            const part = await reader.read()
            if (part.done) break
            buffer += decoder.decode(part.value, { stream: true })
            const packets = buffer.split('\n\n'); buffer = packets.pop() ?? ''
            for (const packet of packets) {
              const id = packet.split('\n').find((line) => line.startsWith('id: '))?.slice(4)
              if (id) lastEventId.current = id
              const raw = packet.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
              if (!raw) continue
              try {
                const event = JSON.parse(raw) as { payload?: { event?: { type?: string; text?: string; toolName?: string; message?: string } } }
                const item = event.payload?.event
                if (!item) continue
                setStream((items) => item.type === 'text_delta'
                  ? [...items.slice(-199), item.text ?? '']
                  : [...items.slice(-199), `［${item.type}］${item.toolName ?? item.message ?? ''}`])
                if (item.type === 'complete') void loadMessages()
              } catch { /* 忽略非结构化 keepalive */ }
            }
          }
        } catch {
          if (!controller.signal.aborted) setStatus('SSE 断开，正在重连…')
        }
        if (!controller.signal.aborted) await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      }
    }
    void consume()
    return () => controller.abort()
  }, [apiBase, loadMessages, selected, token])

  useEffect(() => {
    let active = true
    const refresh = async (): Promise<void> => {
      const response = await request(`/agent/interactions${selected ? `?sessionId=${encodeURIComponent(selected)}&status=pending` : '?status=pending'}`)
      if (!response.ok || !active) return
      const body = await response.json() as { interactions?: Interaction[] }
      setInteractions(body.interactions ?? [])
    }
    void refresh(); const timer = setInterval(() => void refresh(), 1500)
    return () => { active = false; clearInterval(timer) }
  }, [request, selected])

  const run = async (): Promise<void> => {
    if (!selected || !prompt.trim()) return
    const response = await request(`/agent/sessions/${encodeURIComponent(selected)}/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }),
    })
    if (!response.ok) { setStatus(`提交失败：${await response.text()}`); return }
    setPrompt(''); setStream([]); setStatus('任务已提交，正在接收流式事件')
  }

  const fork = async (): Promise<void> => {
    if (!selected) return
    const response = await request(`/agent/sessions/${encodeURIComponent(selected)}/fork`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    if (!response.ok) { setStatus(`分叉失败：${await response.text()}`); return }
    const body = await response.json() as { session: Session }
    await loadSessions(); setSelected(body.session.sessionId); setStatus('已创建会话分叉')
  }

  const saveSession = async (): Promise<void> => {
    if (!selected || !sessionTitle.trim() || !sessionModel.trim()) return
    const response = await request(`/agent/sessions/${encodeURIComponent(selected)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: sessionTitle, modelId: sessionModel }),
    })
    if (!response.ok) { setStatus(`会话设置保存失败：${await response.text()}`); return }
    await loadSessions(); setStatus('会话标题与模型已保存')
  }

  const rewind = async (messageUuid: string | undefined): Promise<void> => {
    if (!selected || !messageUuid) return
    const response = await request(`/agent/sessions/${encodeURIComponent(selected)}/rewind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageUuid }) })
    if (!response.ok) { setStatus(`回退失败：${await response.text()}`); return }
    await loadMessages(); setStatus('会话已回退到所选消息')
  }

  const resolveInteraction = async (item: Interaction, action?: 'approve_auto' | 'approve_edit' | 'deny' | 'feedback'): Promise<void> => {
    const response = item.kind === 'permission'
      ? { requestId: item.requestId, behavior: action === 'deny' ? 'deny' : 'allow', alwaysAllow: false }
      : item.kind === 'plan'
        ? { requestId: item.requestId, action: action ?? 'approve_auto', feedback: planFeedback[item.requestId] || undefined }
        : { requestId: item.requestId, answers: Object.fromEntries((item.request.questions ?? []).map((question) => [question.question, answers[`${item.requestId}:${question.question}`] ?? ''])) }
    const result = await request(`/agent/interactions/${encodeURIComponent(item.requestId)}/respond`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response, expectedVersion: item.version, resolutionId: crypto.randomUUID() }),
    })
    if (!result.ok) { setStatus(`交互提交失败：${await result.text()}`); return }
    setInteractions((items) => items.filter((current) => current.requestId !== item.requestId))
  }

  const loadAdmin = async (path: string): Promise<void> => {
    const response = await request(path)
    setAdmin(await response.json())
  }

  const exportAudit = (): void => {
    const query = new URLSearchParams({ format: 'csv' })
    if (auditAction) query.set('action', auditAction)
    window.open(`${apiBase}/agent/audit/export?${query}`, '_blank', 'noopener,noreferrer')
  }

  return <main className="shell">
    <header className="topbar"><div><p className="eyebrow">PROMA WEB · SERVER AGENT</p><h1>任务控制台</h1></div><span className="status">{status}</span></header>
    <section className="card connection"><label>API Base URL<input value={apiBase} onChange={(event) => setApiBase(event.target.value)} /></label><label>Bearer Token<input value={token} onChange={(event) => setToken(event.target.value)} type="password" autoComplete="off" /></label><button onClick={() => void loadSessions()}>刷新会话</button></section>
    <section className="workspace">
      <aside className="card sessions"><div className="section-title"><h2>会话</h2><button className="quiet" onClick={() => void fork()} disabled={!selected}>分叉</button></div>{selected && <div className="session-settings"><label>标题<input value={sessionTitle} onChange={(event) => setSessionTitle(event.target.value)} /></label><label>模型<input value={sessionModel} onChange={(event) => setSessionModel(event.target.value)} /></label><small>工作区：{sessions.find((item) => item.sessionId === selected)?.workspaceSlug ?? '-'}</small><button onClick={() => void saveSession()}>保存会话设置</button></div>}{sessions.map((session) => <button className={`session ${selected === session.sessionId ? 'selected' : ''}`} key={session.sessionId} onClick={() => setSelected(session.sessionId)}><b>{session.title}</b><small>{session.modelId} · {session.workspaceSlug}{session.archivedAt ? ' · 已归档' : ''}</small></button>)}</aside>
      <section className="card conversation"><div className="section-title"><div><h2>{sessions.find((item) => item.sessionId === selected)?.title ?? '选择会话'}</h2><small>连续 SSE：自动重连并携带 Last-Event-ID</small></div></div><div className="messages">{messages.map((message, index) => <article className={`message ${message.type}`} key={message.uuid ?? index}><div>{messageText(message) || '（非文本消息）'}</div>{message.uuid && <button className="quiet" onClick={() => void rewind(message.uuid)}>从此回退</button>}</article>)}{stream.length > 0 && <article className="message streaming">{stream.join('')}</article>}</div><div className="composer"><textarea placeholder="输入任务…" value={prompt} onChange={(event) => setPrompt(event.target.value)} /><button onClick={() => void run()} disabled={!selected || !prompt.trim()}>运行 Agent</button></div></section>
      <aside className="side-stack"><section className="card"><h2>待处理交互</h2>{interactions.length === 0 && <p className="muted">当前会话没有待处理审批。</p>}{interactions.map((item) => <InteractionCard key={item.requestId} item={item} answers={answers} setAnswers={setAnswers} feedback={planFeedback[item.requestId] ?? ''} setFeedback={(value) => setPlanFeedback((state) => ({ ...state, [item.requestId]: value }))} onResolve={resolveInteraction} />)}</section><section className="card"><h2>MCP 连接</h2>{mcpServers.length === 0 && <p className="muted">当前工作区没有可显示的 MCP 服务。</p>}{mcpServers.map((server) => <div className="mcp" key={server.serverName}><b>{server.serverName}</b><small>{server.transport} · {server.authType}</small><span className={server.connected ? 'ok' : 'muted'}>{server.connected ? '已授权' : '未授权'}</span></div>)}</section></aside>
    </section>
    <section className="card operations"><div className="section-title"><h2>运维与审计</h2><div><button onClick={() => void loadAdmin('/agent/metrics')}>指标</button><button onClick={() => void loadAdmin('/agent/tasks')}>任务树</button></div></div><div className="audit-actions"><input placeholder="按 action 筛选审计" value={auditAction} onChange={(event) => setAuditAction(event.target.value)} /><button onClick={() => void loadAdmin(`/agent/audit${auditAction ? `?action=${encodeURIComponent(auditAction)}` : ''}`)}>查询审计</button><button className="quiet" onClick={exportAudit}>导出 CSV</button></div>{admin !== undefined && <AdminPanel value={admin} />}</section>
  </main>
}

function InteractionCard(props: { item: Interaction; answers: Record<string, string>; setAnswers: (updater: (state: Record<string, string>) => Record<string, string>) => void; feedback: string; setFeedback: (value: string) => void; onResolve: (item: Interaction, action?: 'approve_auto' | 'approve_edit' | 'deny' | 'feedback') => Promise<void> }): JSX.Element {
  const { item } = props
  if (item.kind === 'ask_user') return <article className="interaction"><b>需要回答</b>{item.request.questions?.map((question) => <label key={question.question}>{question.header ?? question.question}{question.options?.length ? <select value={props.answers[`${item.requestId}:${question.question}`] ?? ''} onChange={(event) => props.setAnswers((state) => ({ ...state, [`${item.requestId}:${question.question}`]: event.target.value }))}><option value="">请选择</option>{question.options.map((option) => <option key={option.label} value={option.label}>{option.label}{option.description ? ` — ${option.description}` : ''}</option>)}</select> : <input value={props.answers[`${item.requestId}:${question.question}`] ?? ''} onChange={(event) => props.setAnswers((state) => ({ ...state, [`${item.requestId}:${question.question}`]: event.target.value }))} />}</label>)}<button onClick={() => void props.onResolve(item)}>提交回答</button></article>
  if (item.kind === 'plan') return <article className="interaction"><b>Plan 审批</b><pre>{item.request.toolInput?.plan ?? '未提供计划详情'}</pre><textarea placeholder="可选反馈或修改意见" value={props.feedback} onChange={(event) => props.setFeedback(event.target.value)} /><div><button onClick={() => void props.onResolve(item, 'approve_auto')}>批准</button><button className="quiet" onClick={() => void props.onResolve(item, 'feedback')}>请求调整</button><button className="danger" onClick={() => void props.onResolve(item, 'deny')}>拒绝</button></div></article>
  return <article className="interaction"><b>工具审批：{item.request.toolName}</b><p>{item.request.description ?? 'Agent 请求执行受控操作。'}</p><div><button onClick={() => void props.onResolve(item)}>允许一次</button><button className="danger" onClick={() => void props.onResolve(item, 'deny')}>拒绝</button></div></article>
}

function AdminPanel({ value }: { value: unknown }): JSX.Element {
  const records = isRecord(value) && Array.isArray(value.records) ? value.records as AdminRecord[] : undefined
  if (!records) return <pre className="admin-json">{JSON.stringify(value, null, 2)}</pre>
  return <div className="audit-table"><div className="audit-row audit-head"><span>时间</span><span>操作</span><span>结果</span><span>Trace</span></div>{records.map((record, index) => <div className="audit-row" key={`${record.createdAt}-${index}`}><span>{record.createdAt ? new Date(record.createdAt).toLocaleString() : '-'}</span><span>{record.action ?? '-'}</span><span>{record.result ?? '-'}</span><span>{record.traceId ?? '-'}</span></div>)}</div>
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function messageText(message: Message): string { return message.message?.content?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('') ?? '' }

createRoot(document.getElementById('root')!).render(<App />)
