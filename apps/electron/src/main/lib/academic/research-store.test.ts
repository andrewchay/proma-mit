import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

describe('崩溃注入与恢复语义（M7）', () => {
  test('半写尾行（无换行结尾）被忽略，原文件保留且已有事件可用', async () => {
    const store = await loadStore()
    const project = sampleProject('p-crash-tail')
    await store.appendEvent('p-crash-tail', {
      commandId: 'c1',
      payload: { type: 'project_created', project: project as never },
    })

    // 模拟写入过程中断电：追加一段无换行的半截 JSON
    const eventsPath = join(store.getResearchDir('p-crash-tail'), 'events.jsonl')
    appendFileSync(eventsPath, '{"revision":2,"commandId":"c2","paylo', 'utf8')

    const state = await store.loadProjectState('p-crash-tail')
    // 已提交的事件仍可用，项目不会因为半写尾巴而打不开
    expect(state.project?.id).toBe('p-crash-tail')
    expect(state.revision).toBe(1)

    const { warnings } = await store.readProjectEventsWithWarnings('p-crash-tail')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('未完成的写入')

    // 原文件未被修改（半截内容仍在，供诊断）
    expect(readFileSync(eventsPath, 'utf8')).toContain('"paylo')
  })

  test('半写尾行之后仍可正常追加（revision 从已提交事件续接）', async () => {
    const store = await loadStore()
    const project = sampleProject('p-crash-continue')
    await store.appendEvent('p-crash-continue', {
      commandId: 'c1',
      payload: { type: 'project_created', project: project as never },
    })
    const eventsPath = join(store.getResearchDir('p-crash-continue'), 'events.jsonl')
    appendFileSync(eventsPath, '{"broken', 'utf8')

    await store.appendEvent('p-crash-continue', {
      commandId: 'c2',
      payload: { type: 'status_changed', from: 'defining', to: 'literature' },
    })

    const state = await store.loadProjectState('p-crash-continue')
    expect(state.project?.status).toBe('literature')
  })

  test('中间行损坏仍整体拒绝（不静默跳过历史事件）', async () => {
    const store = await loadStore()
    const project = sampleProject('p-mid-corrupt')
    await store.appendEvent('p-mid-corrupt', {
      commandId: 'c1',
      payload: { type: 'project_created', project: project as never },
    })
    await store.appendEvent('p-mid-corrupt', {
      commandId: 'c2',
      payload: { type: 'status_changed', from: 'defining', to: 'literature' },
    })

    const eventsPath = join(store.getResearchDir('p-mid-corrupt'), 'events.jsonl')
    const lines = readFileSync(eventsPath, 'utf8').split('\n')
    // 破坏中间行（保留换行结尾 → 属于真实损坏而非半写）
    lines[0] = '{corrupted-middle'
    writeFileSync(eventsPath, lines.join('\n'), 'utf8')

    await expect(store.loadProjectState('p-mid-corrupt')).rejects.toThrow('损坏')
    expect(readFileSync(eventsPath, 'utf8')).toContain('{corrupted-middle')
  })

  test('已换行结尾的损坏尾行属于真实损坏（不当作半写）', async () => {
    const store = await loadStore()
    const project = sampleProject('p-tail-newline')
    await store.appendEvent('p-tail-newline', {
      commandId: 'c1',
      payload: { type: 'project_created', project: project as never },
    })
    const eventsPath = join(store.getResearchDir('p-tail-newline'), 'events.jsonl')
    // 有换行结尾的坏行：不是半写，按损坏处理
    appendFileSync(eventsPath, '{bad-json}\n', 'utf8')

    await expect(store.loadProjectState('p-tail-newline')).rejects.toThrow('损坏')
  })
})
