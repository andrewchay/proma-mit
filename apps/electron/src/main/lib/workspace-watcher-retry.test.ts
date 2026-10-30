import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-watch-retry-'))
const internal = join(temp, 'internal')
const root = join(temp, 'root')
mkdirSync(internal)
mkdirSync(root)
let calls = 0
mock.module('./config-paths', () => ({ getAgentWorkspacesDir: () => internal }))
mock.module('./agent-workspace-manager', () => ({ listAgentWorkspaces: () => [{ id: 'w', rootPath: root }] }))
mock.module('./project-file-changes', () => ({ scanProjectFileChanges: async () => { if (++calls === 1) throw new Error('暂时不可读'); return [] } }))
const { startWorkspaceWatcher, stopWorkspaceWatcher } = await import('./workspace-watcher')
const window = { isDestroyed: () => false, webContents: { send: () => {} } }
afterAll(() => { stopWorkspaceWatcher(); rmSync(temp, { recursive: true, force: true }) })

test('Given 项目扫描暂时失败 When 等待重试 Then 无需新的文件事件也会再次扫描', async () => {
  startWorkspaceWatcher(window as never)
  await new Promise(resolve => setTimeout(resolve, 33500))
  expect(calls).toBe(2)
}, 40000)
