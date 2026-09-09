import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { selectAtom } from 'jotai/utils'
import { fileTreeExpandedStateAtom, relocateExpandedPath, updateExpandedPath } from './file-tree-state'

export function useFileTreeExpanded(stateKey: string, path: string) {
  const expandedAtom = React.useMemo(
    () => selectAtom(fileTreeExpandedStateAtom, (state) => state.get(stateKey)?.get(path) ?? false),
    [path, stateKey],
  )
  const expanded = useAtomValue(expandedAtom)
  const setState = useSetAtom(fileTreeExpandedStateAtom)
  const setExpanded = React.useCallback((update: boolean | ((previous: boolean) => boolean)) => {
    setState((previous) => {
      const current = previous.get(stateKey)?.get(path) ?? false
      return updateExpandedPath(previous, stateKey, path, typeof update === 'function' ? update(current) : update)
    })
  }, [path, setState, stateKey])
  const relocate = React.useCallback((newPath: string) => {
    setState((previous) => relocateExpandedPath(previous, stateKey, path, newPath))
  }, [path, setState, stateKey])
  return [expanded, setExpanded, relocate] as const
}
