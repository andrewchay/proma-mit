import { atom, useAtom } from 'jotai'
import { useEffect, useMemo, useRef } from 'react'

interface PublishedFile { path: string; sha256: string; size: number; publicationId: string }
interface State { workspace: string; files: PublishedFile[]; cursor: string | null; loaded: boolean; busy: boolean; status: string }

function validFile(value: unknown): value is PublishedFile {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<PublishedFile>
  return typeof file.path === 'string' && file.path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !/[\\\u0000-\u001f\u007f]/.test(part))
    && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256)
    && typeof file.publicationId === 'string' && /^[a-f0-9]{32}$/.test(file.publicationId)
    && typeof file.size === 'number' && Number.isSafeInteger(file.size) && file.size >= 0
}

/** 按展示的发布版本撤销，避免删除之后重新发布的文件。 */
export function PublishedFiles({ request }: { request: (path: string, init?: RequestInit) => Promise<Response> }): JSX.Element {
  const stateAtom = useMemo(() => atom<State>({ workspace: '', files: [], cursor: null, loaded: false, busy: false, status: '' }), [])
  const [state, setState] = useAtom(stateAtom)
  const generation = useRef(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 连接变更时清除旧身份的数据
  useEffect(() => {
    generation.current++
    setState(previous => ({ ...previous, files: [], cursor: null, loaded: false, busy: false, status: previous.busy ? '连接已变化；如之前正在撤销，请返回原连接核对结果。' : '' }))
    return () => { generation.current++ }
  }, [request, setState])
  const load = async (more: boolean): Promise<void> => {
    const workspace = state.workspace.trim()
    if (!workspace || workspace !== state.workspace || state.busy || (more && !state.cursor)) return
    const version = ++generation.current
    setState(previous => ({ ...previous, busy: true, status: '' }))
    try {
      const query = more ? `?after=${encodeURIComponent(state.cursor!)}` : ''
      const response = await request(`/agent/workspaces/${encodeURIComponent(workspace)}/shared-files${query}`)
      const body = await response.json() as { files?: PublishedFile[]; nextCursor?: string | null; error?: string }
      if (generation.current !== version) return
      if (!response.ok || !Array.isArray(body.files) || body.files.some(file => !validFile(file))) {
        setState(previous => ({ ...previous, files: [], cursor: null, loaded: false, busy: false, status: body.error ?? `读取失败：${response.status}` })); return
      }
      setState(previous => ({ ...previous, files: more ? [...previous.files, ...body.files!] : body.files!, cursor: body.nextCursor ?? null, loaded: true, busy: false }))
    } catch { if (generation.current === version) setState(previous => ({ ...previous, files: [], cursor: null, loaded: false, busy: false, status: '读取失败，请检查连接。' })) }
  }
  const revoke = async (file: PublishedFile): Promise<void> => {
    if (state.busy) return
    const version = ++generation.current
    setState(previous => ({ ...previous, busy: true, status: '' }))
    try {
      const path = file.path.split('/').map(encodeURIComponent).join('/')
      const response = await request(`/agent/workspaces/${encodeURIComponent(state.workspace)}/shared-files/${path}?publicationId=${encodeURIComponent(file.publicationId)}`, { method: 'DELETE' })
      if (generation.current !== version) return
      if (!response.ok) { setState(previous => ({ ...previous, files: [], cursor: null, loaded: false, busy: false, status: response.status === 409 ? '发布版本已变化或不存在，请重新读取。' : `撤销失败：${response.status}，请重新读取。` })); return }
      setState(previous => ({ ...previous, files: previous.files.filter(item => item.publicationId !== file.publicationId), busy: false, status: `已撤销：${file.path}` }))
    } catch { if (generation.current === version) setState(previous => ({ ...previous, files: [], cursor: null, loaded: false, busy: false, status: '撤销结果未知，请重新读取。' })) }
  }
  return <section className="card shared-files" aria-label="已发布成果">
    <div><p className="eyebrow">PUBLISHED FILES</p><h2>已发布成果</h2><p className="muted">查看自己发布的文件，并撤销当前展示的发布版本。</p></div>
    <div className="shared-controls"><label>自己的工作区<input disabled={state.busy} value={state.workspace} onChange={event => { generation.current++; setState({ ...state, workspace: event.target.value, files: [], cursor: null, loaded: false, status: '' }) }} /></label><button disabled={state.busy || !state.workspace.trim()} onClick={() => void load(false)}>读取已发布成果</button></div>
    {state.status && <p role="status" className="shared-status">{state.status}</p>}
    {state.loaded && !state.files.length && <p className="muted">当前没有已发布成果。</p>}
    {state.files.length > 0 && <ul className="shared-list">{state.files.map(file => <li key={file.publicationId}><div><b>{file.path}</b><small>{file.size.toLocaleString()} 字节 · SHA-256 {file.sha256.slice(0, 12)}…</small></div><button className="quiet" disabled={state.busy} onClick={() => void revoke(file)}>撤销发布</button></li>)}</ul>}
    {state.cursor && <button className="quiet" disabled={state.busy} onClick={() => void load(true)}>加载更多</button>}
  </section>
}
