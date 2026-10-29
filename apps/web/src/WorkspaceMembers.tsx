import { atom, useAtom } from 'jotai'
import { useEffect, useMemo, useRef } from 'react'

interface Member { userId: string; role: 'viewer' | 'editor' }
interface State { workspace: string; memberId: string; members: Member[]; loaded: boolean; busy: boolean; status: string }

/** 所有者管理自己的成员登记；共享成果访问与 Runtime 权限分开。 */
export function WorkspaceMembers({ request }: { request: (path: string, init?: RequestInit) => Promise<Response> }): JSX.Element {
  const stateAtom = useMemo(() => atom<State>({ workspace: '', memberId: '', members: [], loaded: false, busy: false, status: '' }), [])
  const [state, setState] = useAtom(stateAtom)
  const generation = useRef(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 连接变化必须丢弃上一身份的成员列表
  useEffect(() => {
    generation.current++
    setState(previous => ({ ...previous, members: [], loaded: false, busy: false, status: previous.busy ? '连接已变化；如之前正在修改成员，请返回原连接核对结果。' : '' }))
    return () => { generation.current++ }
  }, [request, setState])
  const editWorkspace = (workspace: string): void => {
    generation.current++
    setState(previous => ({ ...previous, workspace, members: [], loaded: false, status: '' }))
  }
  const load = async (): Promise<void> => {
    const workspace = state.workspace.trim()
    if (!workspace || workspace !== state.workspace || state.busy) return
    const version = ++generation.current
    setState(previous => ({ ...previous, busy: true, status: '' }))
    try {
      const response = await request(`/agent/workspaces/${encodeURIComponent(workspace)}/members`)
      const body = await response.json() as { members?: Member[]; error?: string }
      if (generation.current !== version) return
      if (!response.ok || !Array.isArray(body.members)) { setState(previous => ({ ...previous, members: [], loaded: false, busy: false, status: body.error ?? `读取失败：${response.status}` })); return }
      setState(previous => ({ ...previous, members: body.members!, loaded: true, busy: false, status: '' }))
    } catch { if (generation.current === version) setState(previous => ({ ...previous, members: [], loaded: false, busy: false, status: '读取失败，请检查连接。' })) }
  }
  const mutate = async (memberId: string, remove: boolean): Promise<void> => {
    const workspace = state.workspace.trim()
    if (!state.loaded || state.busy) return
    if (!memberId || memberId.trim() !== memberId || /[\/\\\u0000-\u001f\u007f]/.test(memberId)) { setState(previous => ({ ...previous, status: '请输入有效的成员 ID。' })); return }
    if (!remove && state.members.some(member => member.userId === memberId)) { setState(previous => ({ ...previous, status: '该成员已登记，请先核对现有角色。' })); return }
    const version = ++generation.current
    setState(previous => ({ ...previous, busy: true, status: '' }))
    try {
      const response = await request(`/agent/workspaces/${encodeURIComponent(workspace)}/members/${encodeURIComponent(memberId)}`, remove ? { method: 'DELETE' } : { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'viewer', createOnly: true }) })
      if (generation.current !== version) return
      if (!response.ok) { setState(previous => ({ ...previous, members: [], loaded: false, busy: false, status: response.status >= 500 ? '修改结果未知，请重新读取成员列表。' : response.status === 409 ? '成员已存在或工作区不可管理，请重新读取。' : `修改失败：${response.status}，请重新读取成员列表。` })); return }
      setState(previous => ({ ...previous, members: remove ? previous.members.filter(member => member.userId !== memberId) : [...previous.members, { userId: memberId, role: 'viewer' }], memberId: '', busy: false, status: remove ? '成员已撤销。' : '只读成员已登记，可访问已发布成果。' }))
    } catch { if (generation.current === version) setState(previous => ({ ...previous, members: [], loaded: false, busy: false, status: '修改结果未知，请重新读取成员列表。' })) }
  }
  return <section className="card shared-files" aria-label="工作区成员">
    <div><p className="eyebrow">WORKSPACE ACCESS</p><h2>工作区成员</h2><p className="muted">登记成员后，其可读取已发布成果；不授予整个工作区或 Runtime 权限。</p></div>
    <div className="shared-controls"><label>自己的工作区<input disabled={state.busy} value={state.workspace} onChange={event => editWorkspace(event.target.value)} /></label><button disabled={state.busy || !state.workspace.trim()} onClick={() => void load()}>读取成员</button></div>
    {state.status && <p role="status" className="shared-status">{state.status}</p>}
    {state.loaded && <><div className="shared-controls"><label>成员 ID<input disabled={state.busy} value={state.memberId} onChange={event => setState({ ...state, memberId: event.target.value, status: '' })} /></label><button disabled={state.busy || !state.memberId} onClick={() => void mutate(state.memberId, false)}>登记只读成员</button></div>{state.members.length === 0 ? <p className="muted">尚无登记成员。</p> : <ul className="shared-list">{state.members.map(member => <li key={member.userId}><div><b>{member.userId}</b><small>{member.role === 'viewer' ? '只读成员' : '编辑成员（共享成果只读）'}</small></div><button className="quiet" disabled={state.busy} onClick={() => void mutate(member.userId, true)}>撤销成员</button></li>)}</ul>}</>}
  </section>
}
