import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-watch-batch-'))
const internal = join(temp, 'internal')
const root = join(temp, 'root')
mkdirSync(internal)
mkdirSync(root)
let calls = 0
let finish: (() => void) | undefined
mock.module('./config-paths', () => ({ getAgentWorkspacesDir: () => internal }))
mock.module('./agent-workspace-manager', () => ({ listAgentWorkspaces: () => [{ id: 'w', rootPath: root }] }))
mock.module('./project-file-changes', () => ({ scanProjectFileChanges: async () => { calls++; if (calls === 1) await new Promise<void>(resolve => { finish = resolve }); return [] } }))
mock.module('./project-file-change-observations', () => ({ reconcileProjectFileChangeObservations: async () => {} }))
const { startWorkspaceWatcher, stopWorkspaceWatcher } = await import('./workspace-watcher')
const window = { isDestroyed: () => false, webContents: { send: () => {} } }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
afterAll(() => { finish?.(); stopWorkspaceWatcher(); rmSync(temp, { recursive: true, force: true }) })

test('Given 扫描正在进行 When 文件持续变化 Then 合并为一次后续扫描', async () => {
  startWorkspaceWatcher(window as never)
  await pause(2300)
  expect(calls).toBe(1)
  for (let i = 0; i < 5; i++) writeFileSync(join(root, `file-${i}`), 'change')
  await pause(2300)
  expect(calls).toBe(1)
  finish?.()
  await pause(2300)
  expect(calls).toBe(2)
}, 10000)
