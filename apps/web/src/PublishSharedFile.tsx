import { atom, useAtom } from 'jotai'
import { useEffect, useMemo, useRef } from 'react'
import { saveDownload } from './download'

interface ReviewedFile { path: string; workspace: string; hash: string; bytes: Uint8Array<ArrayBuffer>; contentType: string }
interface PublishState { workspace: string; path: string; reviewed?: ReviewedFile; status: string; busy: boolean }
const MAX_REVIEW_BYTES = 10_000_000

function encodePath(path: string): string | null {
  const parts = path.split('/')
  if (!path || parts.some(part => !part || part === '.' || part === '..' || /[\\\u0000-\u001f\u007f]/.test(part))) return null
  return parts.map(encodeURIComponent).join('/')
}

async function readReviewBody(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_REVIEW_BYTES) { await reader.cancel(); throw new Error('文件超过此界面的 10 MB 核对上限') }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  } finally { reader.releaseLock() }
}

/** 所有者先核对固定字节及哈希，再主动发布；服务端会重新校验哈希。 */
export function PublishSharedFile({ request }: { request: (path: string, init?: RequestInit) => Promise<Response> }): JSX.Element {
  const stateAtom = useMemo(() => atom<PublishState>({ workspace: '', path: '', status: '', busy: false }), [])
  const [state, setState] = useAtom(stateAtom)
  const generation = useRef(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 连接身份变化时清除已核对文件
  useEffect(() => {
    generation.current++
    setState(previous => ({ ...previous, reviewed: undefined, status: previous.busy && previous.reviewed ? '连接已变化，发布结果未知，请返回原连接核对共享列表。' : '', busy: false }))
    return () => { generation.current++ }
  }, [request, setState])
  const edit = (field: 'workspace' | 'path', value: string): void => {
    generation.current++
    setState(previous => ({ ...previous, [field]: value, reviewed: undefined, status: '' }))
  }
  const review = async (): Promise<void> => {
    const workspace = state.workspace.trim(), path = state.path.trim(), encoded = encodePath(path)
    if (!workspace || !encoded || state.path !== path || state.workspace !== workspace || state.busy) { setState(previous => ({ ...previous, status: '请输入工作区和有效的相对文件路径。' })); return }
    const version = ++generation.current
    setState(previous => ({ ...previous, reviewed: undefined, status: '', busy: true }))
    try {
      const response = await request(`/agent/workspaces/${encodeURIComponent(workspace)}/files/${encoded}`)
      if (!response.ok) throw new Error(`读取失败：${response.status}`)
      const bytes = await readReviewBody(response)
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
      if (generation.current !== version) return
      setState(previous => ({ ...previous, reviewed: { workspace, path, bytes, hash, contentType: response.headers.get('content-type') ?? '' }, busy: false, status: '已读取文件，请核对后决定是否发布。' }))
    } catch (error) {
      if (generation.current === version) setState(previous => ({ ...previous, busy: false, status: error instanceof Error ? error.message : '读取失败' }))
    }
  }
  const publish = async (): Promise<void> => {
    const file = state.reviewed
    if (!file || state.busy) return
    const encoded = encodePath(file.path)
    if (!encoded) return
    const version = ++generation.current
    setState(previous => ({ ...previous, busy: true, status: '' }))
    try {
      const response = await request(`/agent/workspaces/${encodeURIComponent(file.workspace)}/shared-files/${encoded}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedSha256: file.hash }) })
      if (generation.current !== version) return
      if (!response.ok) { setState(previous => ({ ...previous, reviewed: undefined, busy: false, status: response.status === 409 ? '文件已变化，请重新读取并核对。' : `发布失败：${response.status}` })); return }
      setState(previous => ({ ...previous, reviewed: undefined, busy: false, status: '已发布；当前登记的成员可读取此版本。' }))
    } catch { if (generation.current === version) setState(previous => ({ ...previous, reviewed: undefined, busy: false, status: '发布结果未知，请重新核对共享列表。' })) }
  }
  const preview = state.reviewed && /^(text\/|application\/(json|xml))/i.test(state.reviewed.contentType) ? new TextDecoder().decode(state.reviewed.bytes).slice(0, 5000) : ''
  return <section className="card shared-files" aria-label="发布共享成果">
    <div><p className="eyebrow">OWNER REVIEW</p><h2>发布共享成果</h2><p className="muted">先读取工作区中的现有文件，核对后再发布给当前成员。</p></div>
    <div className="shared-controls"><label>自己的工作区<input disabled={state.busy} value={state.workspace} onChange={event => edit('workspace', event.target.value)} /></label><label>相对文件路径<input disabled={state.busy} value={state.path} onChange={event => edit('path', event.target.value)} placeholder="例如 reports/summary.md" /></label><button disabled={state.busy} onClick={() => void review()}>读取并核对</button></div>
    {state.status && <p role="status" className="shared-status">{state.status}</p>}
    {state.reviewed && <div className="shared-review"><p><b>{state.reviewed.path}</b> · {state.reviewed.bytes.byteLength.toLocaleString()} 字节</p><p className="shared-hash">SHA-256 {state.reviewed.hash}</p>{preview && <><p className="muted">文本预览最多 5000 字符；完整内容请下载核对。</p><pre>{preview}</pre></>}<div className="audit-actions"><button className="quiet" disabled={state.busy} onClick={() => saveDownload(new Blob([state.reviewed!.bytes], { type: state.reviewed!.contentType || 'application/octet-stream' }), state.reviewed!.path.split('/').pop() || 'download')}>下载核对内容</button><button disabled={state.busy} onClick={() => void publish()}>确认发布此版本</button></div></div>}
  </section>
}
