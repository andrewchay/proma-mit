import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** 保持 portal 节点稳定；Owner 目标重读或编辑时，暂时移到备用位置而不重建表单。 */
export function ProjectDetailsPlacement({ target, visible, children }: { target: HTMLElement | null; visible: boolean; children: ReactNode }): React.ReactElement {
  const fallback = useRef<HTMLDivElement>(null)
  const portal = useMemo(() => typeof document === 'undefined' ? null : document.createElement('div'), [])
  useLayoutEffect(() => {
    const host = target ?? fallback.current
    if (host && portal && portal.parentElement !== host) host.appendChild(portal)
  }, [target, portal])
  useEffect(() => () => { portal?.remove() }, [portal])
  return <><div ref={fallback} hidden={Boolean(target) || !visible} />{portal ? createPortal(children, portal) : children}</>
}
