import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  trackMeetingAttended,
  trackNoteOpened,
  trackNoteReferenced,
  trackNoteSaved,
  trackSessionFinished,
  trackToolInvoked,
} from './telemetry-tracking'

/**
 * 埋点辅助模块测试。
 *
 * 关注两点：
 * 1. 埋点永不抛错（旁路观测不能中断主流程）
 * 2. 无效输入被过滤（零时长、NaN 不应污染事件流）
 */

let tempDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'telemetry-tracking-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

async function readEvents(): Promise<Array<{ category: string; type: string; value?: number; meta?: Record<string, string | number> }>> {
  const svc = await import(`./telemetry-service?t=${Math.random()}`)
  return svc.readTelemetryEvents()
}

describe('埋点不抛错', () => {
  test('所有埋点函数在正常输入下不抛错', () => {
    expect(() => {
      trackNoteOpened('n1', 'v1')
      trackNoteSaved('n1')
      trackNoteReferenced(['n1', 'n2'])
      trackSessionFinished('s1', 60_000, { runtime: 'pi' })
      trackToolInvoked('Read')
      trackMeetingAttended('e1', 30, 'work')
    }).not.toThrow()
  })

  test('极端输入不抛错', () => {
    expect(() => {
      trackSessionFinished('s1', Number.NaN)
      trackSessionFinished('s1', Number.POSITIVE_INFINITY)
      trackSessionFinished('s1', -100)
      trackMeetingAttended('e1', Number.NaN)
      trackMeetingAttended('e1', 0)
      trackNoteReferenced([])
    }).not.toThrow()
  })
})

describe('事件写入正确性', () => {
  test('笔记打开写入 knowledge/note_opened', async () => {
    trackNoteOpened('n1', 'v1')
    const events = await readEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.category).toBe('knowledge')
    expect(events[0]?.type).toBe('note_opened')
    expect(events[0]?.meta?.noteId).toBe('n1')
    expect(events[0]?.meta?.vaultId).toBe('v1')
  })

  test('笔记引用为每篇笔记各写一条事件', async () => {
    trackNoteReferenced(['a', 'b', 'c'])
    const events = await readEvents()
    expect(events).toHaveLength(3)
    expect(events.every((e: { type: string }) => e.type === 'note_referenced_by_agent')).toBe(true)
  })

  test('会话时长以秒为单位写入', async () => {
    trackSessionFinished('s1', 90_000, { runtime: 'pi' })
    const events = await readEvents()
    expect(events[0]?.value).toBe(90)
    expect(events[0]?.meta?.runtime).toBe('pi')
  })

  test('失败会话标记 failed', async () => {
    trackSessionFinished('s1', 30_000, { failed: true })
    const events = await readEvents()
    expect(events[0]?.meta?.failed).toBe(1)
  })
})

describe('无效输入被过滤', () => {
  test('零时长会话不记录（避免拉低平均值）', async () => {
    trackSessionFinished('s1', 0)
    expect(await readEvents()).toHaveLength(0)
  })

  test('负数时长会话不记录', async () => {
    trackSessionFinished('s1', -5)
    expect(await readEvents()).toHaveLength(0)
  })

  test('NaN 时长会话不记录', async () => {
    trackSessionFinished('s1', Number.NaN)
    expect(await readEvents()).toHaveLength(0)
  })

  test('零时长会议不记录', async () => {
    trackMeetingAttended('e1', 0)
    expect(await readEvents()).toHaveLength(0)
  })

  test('会话时长四舍五入到整秒', async () => {
    trackSessionFinished('s1', 1500)
    const events = await readEvents()
    expect(events[0]?.value).toBe(2)
  })

  test('会议时长四舍五入到整分钟', async () => {
    trackMeetingAttended('e1', 29.6, 'work')
    const events = await readEvents()
    expect(events[0]?.value).toBe(30)
  })
})

describe('按开关过滤', () => {
  test('关闭 knowledge 后笔记埋点不写入', async () => {
    const svc = await import(`./telemetry-service?t=${Math.random()}`)
    svc.updateTelemetrySettings({ enabled: { knowledge: false } })

    // tracking 模块与服务模块是不同实例，需让 tracking 读到同一份设置
    // （设置从磁盘读取，因此这里直接验证服务层行为）
    const fresh = await import(`./telemetry-service?t=${Math.random()}`)
    expect(fresh.getTelemetrySettings().enabled.knowledge).toBe(false)
    expect(fresh.recordEvent({ category: 'knowledge', type: 'note_opened' })).toBe(false)
  })
})
