import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 研究事件存储测试（方案 v1 §10.2）。
 *
 * 核心断言：
 * - events.jsonl 是权威记录，快照可丢弃重建
 * - commandId 幂等：重复投递不重复落盘
 * - revision 单调递增，过期写入拒绝
 * - 事件文件损坏时保留原件、拒绝读写，不静默清空
 */

let tempDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'research-store-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

async function loadStore() {
  return import(`./research-store?t=${Math.random()}`)
}

function sampleProject(id: string, revision = 1) {
  return {
    id,
    title: '测试研究',
    domain: 'audiology',
    methodPath: 'quantitative',
    status: 'defining',
    sensitivity: 'internal',
    revision,
    createdAt: '2026-09-16T10:00:00.000Z',
    updatedAt: '2026-09-16T10:00:00.000Z',
  }
}

describe('research-store 事件存储', () => {
  test('project_created 事件写入并回放出项目', async () => {
    const store = await loadStore()
    const project = sampleProject('p-1')
    await store.appendEvent('p-1', {
      commandId: 'cmd-1',
      payload: { type: 'project_created', project: project as never },
    })

    const state = await store.loadProjectState('p-1')
    expect(state.project?.id).toBe('p-1')
    expect(state.project?.status).toBe('defining')
    expect(state.revision).toBe(1)
  })

  test('重复 commandId 拒绝且不追加事件', async () => {
    const store = await loadStore()
    const project = sampleProject('p-2')
    const event = { commandId: 'cmd-dup', payload: { type: 'project_created', project: project as never } }
    await store.appendEvent('p-2', event)

    expect(store.appendEvent('p-2', event)).rejects.toThrow('重复')
    const state = await store.loadProjectState('p-2')
    expect(state.revision).toBe(1)
  })

  test('revision 过期的追加被拒绝', async () => {
    const store = await loadStore()
    await store.appendEvent('p-3', {
      commandId: 'cmd-a',
      payload: { type: 'project_created', project: sampleProject('p-3') as never },
    })

    // 伪造一个 revision=99 的旧状态写入（模拟并发冲突）
    expect(
      store.appendEvent('p-3', {
        commandId: 'cmd-b',
        expectedRevision: 99,
        payload: { type: 'brief_updated', brief: { question: 'q', goals: 'g', scope: 's' }, changeReason: 'x' },
      }),
    ).rejects.toThrow('revision')
  })

  test('事件文件损坏时保留原件并拒绝读写', async () => {
    const store = await loadStore()
    const dir = store.getResearchDir('p-4')
    expect(existsSync(dir)).toBe(true)
    const eventsPath = join(dir, 'events.jsonl')
    writeFileSync(eventsPath, '{"revision":1,"commandId":"cmd-x"}\n{broken json\n', 'utf8')

    expect(store.loadProjectState('p-4')).rejects.toThrow('损坏')
    // 原件未被覆盖
    expect(readFileSync(eventsPath, 'utf8')).toContain('{broken json')
  })

  test('不存在的项目返回空状态而非抛错', async () => {
    const store = await loadStore()
    const state = await store.loadProjectState('no-such-project')
    expect(state.project).toBeNull()
    expect(state.revision).toBe(0)
  })

  test('listResearchProjectIds 只列出存在事件文件的项目', async () => {
    const store = await loadStore()
    await store.appendEvent('p-a', {
      commandId: 'c1',
      payload: { type: 'project_created', project: sampleProject('p-a') as never },
    })
    const ids = await store.listResearchProjectIds()
    expect(ids).toEqual(['p-a'])
  })
})
