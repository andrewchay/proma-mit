import { atom } from 'jotai'

export type FileTreeExpandedState = Map<string, Map<string, boolean>>

/** Jotai 运行态；由持久化 Hook 同步到本地主进程 settings.json。 */
export const fileTreeExpandedStateAtom = atom<FileTreeExpandedState>(new Map())
export const fileTreeScrollStateAtom = atom<Map<string, number>>(new Map())

export interface PersistedFileTreeState {
  expandedPaths: string[]
  scrollTop: number
}

export function serializeFileTreeState(
  expanded: ReadonlyMap<string, boolean> | undefined,
  scrollTop: number | undefined,
): PersistedFileTreeState {
  return {
    expandedPaths: [...(expanded ?? [])]
      .filter(([, isExpanded]) => isExpanded)
      .map(([path]) => path),
    scrollTop: Math.max(0, scrollTop ?? 0),
  }
}

export function restoreExpandedFileTreeState(paths: readonly string[]): Map<string, boolean> {
  return new Map(paths.filter((path) => typeof path === 'string' && path.length > 0).map((path) => [path, true]))
}

export function updateExpandedPath(
  state: FileTreeExpandedState,
  stateKey: string,
  path: string,
  expanded: boolean,
): FileTreeExpandedState {
  const current = state.get(stateKey)
  if (current?.get(path) === expanded) return state
  const paths = new Map(current)
  paths.set(path, expanded)
  const next = new Map(state)
  next.set(stateKey, paths)
  return next
}

function isPathWithin(path: string, parent: string): boolean {
  const windowsPath = /^[a-z]:[/\\]/i.test(parent) || parent.startsWith('\\\\')
  return path === parent || path.startsWith(`${parent}/`) || (windowsPath && path.startsWith(`${parent}\\`))
}

export function relocateExpandedPath(
  state: FileTreeExpandedState,
  stateKey: string,
  oldPath: string,
  newPath: string,
): FileTreeExpandedState {
  const current = state.get(stateKey)
  if (!current || oldPath === newPath) return state
  const paths = new Map(current)
  let changed = false
  for (const path of current.keys()) {
    if (isPathWithin(path, oldPath) || isPathWithin(path, newPath)) {
      paths.delete(path)
      changed = true
    }
  }
  if (!changed) return state
  for (const [path, expanded] of current) {
    if (isPathWithin(path, oldPath)) paths.set(newPath + path.slice(oldPath.length), expanded)
  }
  const next = new Map(state)
  next.set(stateKey, paths)
  return next
}

export function pruneFileTreeState<T>(state: Map<string, T>, retainedSessionIds: ReadonlySet<string>): Map<string, T> {
  const next = new Map(state)
  let changed = false
  for (const key of state.keys()) {
    const separator = key.indexOf('\u0002')
    const sessionId = separator >= 0 ? key.slice(0, separator) : key
    if (sessionId !== 'standalone' && !retainedSessionIds.has(sessionId)) {
      next.delete(key)
      changed = true
    }
  }
  return changed ? next : state
}

export function fileTreeStateKey(sessionId: string | undefined, scope: string, rootPath: string): string {
  return `${sessionId || 'standalone'}\u0002${scope}\u0002${rootPath}`
}

export function clampRestoredScrollTop(saved: number, scrollHeight: number, clientHeight: number): number {
  return Math.min(Math.max(0, saved), Math.max(0, scrollHeight - clientHeight))
}
