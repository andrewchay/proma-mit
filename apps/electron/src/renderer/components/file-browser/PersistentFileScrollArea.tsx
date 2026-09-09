import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { clampRestoredScrollTop, fileTreeScrollStateAtom } from './file-tree-state'

interface PersistentFileScrollAreaProps {
  stateKey: string
  className?: string
  children: React.ReactNode
}

/** 切换会话或文件来源后恢复滚动位置；异步展开目录时会继续尝试直至达到目标。 */
export function PersistentFileScrollArea({ stateKey, className, children }: PersistentFileScrollAreaProps): React.ReactElement {
  const positions = useAtomValue(fileTreeScrollStateAtom)
  const setPositions = useSetAtom(fileTreeScrollStateAtom)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const latestRef = React.useRef(positions.get(stateKey) ?? 0)

  React.useLayoutEffect(() => {
    latestRef.current = positions.get(stateKey) ?? 0
    const container = containerRef.current
    if (!container) return
    const restore = (): void => {
      container.scrollTop = clampRestoredScrollTop(latestRef.current, container.scrollHeight, container.clientHeight)
    }
    restore()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(restore)
    observer?.observe(container)
    return () => observer?.disconnect()
  }, [positions, stateKey])

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let saveTimeout: number | undefined
    const persist = (): void => {
      const scrollTop = latestRef.current
      setPositions((previous) => {
        if (previous.get(stateKey) === scrollTop) return previous
        const next = new Map(previous)
        next.set(stateKey, scrollTop)
        return next
      })
    }
    const save = (): void => {
      latestRef.current = container.scrollTop
      if (saveTimeout !== undefined) window.clearTimeout(saveTimeout)
      saveTimeout = window.setTimeout(persist, 120)
    }
    container.addEventListener('scroll', save, { passive: true })
    return () => {
      container.removeEventListener('scroll', save)
      if (saveTimeout !== undefined) window.clearTimeout(saveTimeout)
      persist()
    }
  }, [setPositions, stateKey])

  return <div ref={containerRef} className={className}>{children}</div>
}
