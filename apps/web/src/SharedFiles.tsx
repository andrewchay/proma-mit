import { atom, useAtom } from 'jotai'
import { useEffect, useMemo, useRef } from 'react'
import { saveDownload } from './download'

interface SharedFile { path: string; sha256: string; size: number; publishedAt: number }
interface SharedFilesState { owner: string; workspace: string; files: SharedFile[]; cursor: string | null; status: string; loading: boolean; loaded: boolean }

/** 成员通过服务端重新校验读取已发布成果，不缓存跨身份的列表。 */
export function SharedFiles({ request }: { request: (path: string, init?: RequestInit) => Promise<Response> }): JSX.Element {
  const stateAtom = useMemo(() => atom<SharedFilesState>({ owner: '', workspace: '', files: [], cursor: null, status: '', loading: false, loaded: false }), [])
  const [state, setState] = useAtom(stateAtom)
  const generation = useRef(0)
  // 连接身份变化时必须清除上一身份的可见数据。
  // biome-ignore lint/correctness/useExhaustiveDependencies: request 的身份代表当前 API 地址与令牌
  useEffect(() => {
    generation.current++
    setState(previous => ({ ...previous, files: [], cursor: null, status: '', loading: false, loaded: false }))
  }, [request, setState])
  const edit = (field: 'owner' | 'workspace', value: string): void => {
    generation.current++
    setState(previous => ({ ...previous, [field]: value, files: [], cursor: null, status: '', loading: false, loaded: false }))
  }
  const load = async (more: boolean): Promise<void> => {
    const owner = state.owner.trim(), workspace = state.workspace.trim()
    if (!owner || !workspace || state.loading || (more && !state.cursor)) return
    const version = ++generation.current
    setState(previous => ({ ...previous, loading: true, status: '' }))
    try {
      const query = more ? `?after=${encodeURIComponent(state.cursor!)}` : ''
      const response = await request(`/agent/shared-workspaces/${encodeURIComponent(owner)}/${encodeURIComponent(workspace)}/files${query}`)
      const body = await response.json() as { files?: SharedFile[]; nextCursor?: string | null; error?: string }
      if (generation.current !== version) return
      if (!response.ok || !Array.isArray(body.files)) {
        setState(previous => ({ ...previous, files: [], cursor: null, loaded: false, loading: false, status: body.error ?? `加载失败：${response.status}` }))
        return
      }
      setState(previous => ({ ...previous, files: more ? [...previous.files, ...body.files!] : body.files!, cursor: body.nextCursor ?? null, loaded: true, loading: false }))
    } catch {
      if (generation.current === version) setState(previous => ({ ...previous, files: [], cursor: null, loaded: false, loading: false, status: '加载失败，请检查连接后重试。' }))
    }
  }
  const download = async (file: SharedFile): Promise<void> => {
    const version = generation.current
    try {
      const response = await request(`/agent/shared-workspaces/${encodeURIComponent(state.owner.trim())}/${encodeURIComponent(state.workspace.trim())}/files/${file.path.split('/').map(encodeURIComponent).join('/')}`)
      if (generation.current !== version) return
      if (!response.ok) { setState(previous => ({ ...previous, files: [], cursor: null, loaded: false, status: `文件不可用（${response.status}），请重新加载列表。` })); return }
      const blob = await response.blob()
      if (generation.current !== version) return
      saveDownload(blob, file.path.split('/').pop() || 'download')
    } catch { if (generation.current === version) setState(previous => ({ ...previous, status: '下载失败，请检查连接后重试。' })) }
  }
  return <section className="card shared-files" aria-label="共享成果">
    <div><p className="eyebrow">SHARED WORKSPACE</p><h2>共享成果</h2><p className="muted">输入所有者与工作区，查看你当前有权访问的已发布文件。</p></div>
    <div className="shared-controls"><label>所有者 ID<input value={state.owner} onChange={event => edit('owner', event.target.value)} /></label><label>工作区<input value={state.workspace} onChange={event => edit('workspace', event.target.value)} /></label><button disabled={state.loading || !state.owner.trim() || !state.workspace.trim()} onClick={() => void load(false)}>查看成果</button></div>
    {state.status && <p role="status" className="shared-status">{state.status}</p>}
    {state.loaded && state.files.length === 0 && <p className="muted">当前没有已发布的成果。</p>}
    {state.files.length > 0 && <ul className="shared-list">{state.files.map(file => <li key={file.path}><div><b>{file.path}</b><small>{file.size.toLocaleString()} 字节 · SHA-256 {file.sha256.slice(0, 12)}…</small></div><button className="quiet" onClick={() => void download(file)}>下载</button></li>)}</ul>}
    {state.cursor && <button className="quiet" disabled={state.loading} onClick={() => void load(true)}>加载更多</button>}
  </section>
}
