import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-watch-'))
const internal = join(temp, 'workspaces')
const project = join(temp, 'project')
mkdirSync(internal)
mkdirSync(project)
let workspaces: Array<{ id: string; rootPath?: string }> = [{ id: 'project', rootPath: project }]
mock.module('./config-paths', () => ({ getAgentWorkspacesDir: () => internal, getProjectsDir: () => join(temp, 'data') }))
mock.module('./agent-workspace-manager', () => ({ listAgentWorkspaces: () => workspaces }))
mock.module('./project-file-change-policy', () => ({ invalidateWorkspaceFileChangePolicies: () => {} }))
const { isProjectRootWatched, startWorkspaceWatcher, stopWorkspaceWatcher, syncProjectRootWatchers } = await import('./workspace-watcher')
const events: string[] = []
let onChange: (() => void) | undefined
const window = { isDestroyed: () => false, webContents: { send: (channel: string) => { events.push(channel); if (channel === 'agent:workspace-files-changed') onChange?.() } } }
function waitForFileChange(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onChange = undefined; reject(new Error('等待工作区文件变更通知超时')) }, 8000)
    onChange = () => { clearTimeout(timer); onChange = undefined; resolve() }
  })
}

afterAll(() => { stopWorkspaceWatcher(); rmSync(temp, { recursive: true, force: true }) })

describe('本地项目文件监听', () => {
  test('已有项目的外部文件修改触发刷新，删除工作区后停止监听', async () => {
    startWorkspaceWatcher(window as never)
    expect(isProjectRootWatched(project)).toBe(true)
    const changed = waitForFileChange()
    writeFileSync(join(project, 'first.txt'), 'first')
    await changed
    expect(events).toContain('agent:workspace-files-changed')
    events.length = 0
    workspaces = []
    syncProjectRootWatchers()
    expect(isProjectRootWatched(project)).toBe(false)
    writeFileSync(join(project, 'second.txt'), 'second')
    expect(events).toEqual([])
  }, 10000)
})
