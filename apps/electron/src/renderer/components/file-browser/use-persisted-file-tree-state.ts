import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  fileTreeExpandedStateAtom,
  fileTreeScrollStateAtom,
  restoreExpandedFileTreeState,
  serializeFileTreeState,
} from './file-tree-state'

/** 将 Jotai 运行态同步到本地 settings.json，并在应用重启后恢复。 */
export function usePersistedFileTreeState(stateKey: string): void {
  const expandedState = useAtomValue(fileTreeExpandedStateAtom)
  const scrollState = useAtomValue(fileTreeScrollStateAtom)
  const setExpandedState = useSetAtom(fileTreeExpandedStateAtom)
  const setScrollState = useSetAtom(fileTreeScrollStateAtom)
  const hydratedKeyRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    hydratedKeyRef.current = null
    void window.electronAPI.getSettings().then((settings) => {
      if (cancelled) return
      const persisted = settings.fileTreeViewState?.[stateKey]
      if (persisted) {
        setExpandedState((previous) => {
          const next = new Map(previous)
          next.set(stateKey, restoreExpandedFileTreeState(persisted.expandedPaths))
          return next
        })
        setScrollState((previous) => {
          const next = new Map(previous)
          next.set(stateKey, Math.max(0, persisted.scrollTop))
          return next
        })
      }
      hydratedKeyRef.current = stateKey
    }).catch((error) => {
      console.error('[文件树] 恢复视图状态失败:', error)
      hydratedKeyRef.current = stateKey
    })
    return () => { cancelled = true }
  }, [setExpandedState, setScrollState, stateKey])

  const expanded = expandedState.get(stateKey)
  const scrollTop = scrollState.get(stateKey)
  React.useEffect(() => {
    if (hydratedKeyRef.current !== stateKey) return
    const timeout = window.setTimeout(() => {
      const persisted = serializeFileTreeState(expanded, scrollTop)
      void window.electronAPI.updateSettings({
        fileTreeViewState: { [stateKey]: persisted },
      }).catch((error) => console.error('[文件树] 保存视图状态失败:', error))
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [expanded, scrollTop, stateKey])
}
