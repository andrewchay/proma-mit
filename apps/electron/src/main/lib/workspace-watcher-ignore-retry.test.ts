import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-watch-ignore-'))
const internal = join(temp, 'internal'), root = join(temp, 'root')
mkdirSync(internal); mkdirSync(root)
let calls = 0, invalidations = 0
mock.module('./config-paths', () => ({ getAgentWorkspacesDir: () => internal }))
mock.module('./agent-workspace-manager', () => ({ listAgentWorkspaces: () => [{ id: 'w', rootPath: root }] }))
mock.module('./project-file-changes', () => ({ scanProjectFileChanges: async () => { if (++calls === 1) throw new Error('文件数量超过项目变化扫描上限'); return [] } }))
mock.module('./project-file-change-observations', () => ({ reconcileProjectFileChangeObservations: async () => {} }))
mock.module('./project-file-change-policy', () => ({ invalidateWorkspaceFileChangePolicies: () => { invalidations++ } }))
const { startWorkspaceWatcher, stopWorkspaceWatcher } = await import('./workspace-watcher')
afterAll(() => { stopWorkspaceWatcher(); rmSync(temp, { recursive: true, force: true }) })

test('Given 项目扫描失败正在退避 When 用户修改忽略规则 Then 失效旧授权并及时重新扫描', async () => {
  startWorkspaceWatcher({ isDestroyed: () => false, webContents: { send: () => {} } } as never)
  await new Promise(resolve => setTimeout(resolve, 2500))
  expect(calls).toBe(1)
  writeFileSync(join(root, '.gravitasignore'), 'out-dev\n')
  await new Promise(resolve => setTimeout(resolve, 2500))
  expect(invalidations).toBeGreaterThan(0)
  expect(calls).toBe(2)
}, 10000)
