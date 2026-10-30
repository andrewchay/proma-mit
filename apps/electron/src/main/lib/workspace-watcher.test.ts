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
const { startWorkspaceWatcher, stopWorkspaceWatcher, syncProjectRootWatchers } = await import('./workspace-watcher')
const events: string[] = []
const window = { isDestroyed: () => false, webContents: { send: (channel: string) => events.push(channel) } }
const pause = () => new Promise((resolve) => setTimeout(resolve, 700))

afterAll(() => { stopWorkspaceWatcher(); rmSync(temp, { recursive: true, force: true }) })

describe('本地项目文件监听', () => {
  test('已有项目的外部文件修改触发刷新，删除工作区后停止监听', async () => {
    startWorkspaceWatcher(window as never)
    writeFileSync(join(project, 'first.txt'), 'first')
    await pause()
    expect(events).toContain('agent:workspace-files-changed')
    events.length = 0
    workspaces = []
    syncProjectRootWatchers()
    writeFileSync(join(project, 'second.txt'), 'second')
    await pause()
    expect(events).toEqual([])
  })
})
