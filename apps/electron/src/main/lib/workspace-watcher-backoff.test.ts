import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-watch-backoff-'))
const internal = join(temp, 'internal'), root = join(temp, 'root')
mkdirSync(internal); mkdirSync(root)
let calls = 0
mock.module('./config-paths', () => ({ getAgentWorkspacesDir: () => internal }))
mock.module('./agent-workspace-manager', () => ({ listAgentWorkspaces: () => [{ id: 'w', rootPath: root }] }))
mock.module('./project-file-changes', () => ({ scanProjectFileChanges: async () => { calls++; throw new Error('扫描失败') } }))
mock.module('./project-file-change-observations', () => ({ reconcileProjectFileChangeObservations: async () => {} }))
mock.module('./project-file-change-policy', () => ({ invalidateWorkspaceFileChangePolicies: () => {} }))
const { startWorkspaceWatcher, stopWorkspaceWatcher } = await import('./workspace-watcher')
afterAll(() => { stopWorkspaceWatcher(); rmSync(temp, { recursive: true, force: true }) })

test('Given 扫描持续失败 When 自动重试 Then 逐次退避且不超过十五分钟', async () => {
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout
  const timers = new Map<number, { callback: () => void; delay: number }>()
  let nextId = 0
  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    const id = ++nextId
    timers.set(id, { callback, delay })
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as unknown as typeof clearTimeout
  try {
    startWorkspaceWatcher({ isDestroyed: () => false, webContents: { send: () => {} } } as never)
    for (const expected of [2000, 30000, 60000, 120000, 240000, 480000, 900000, 900000]) {
      const entry = [...timers.entries()][0]
      expect(entry?.[1].delay).toBe(expected)
      timers.delete(entry![0])
      entry![1].callback()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }
    expect(calls).toBe(8)
  } finally {
    stopWorkspaceWatcher()
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})
