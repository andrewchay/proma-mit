import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 采集服务测试。
 *
 * 核心断言是隐私边界：情绪数据在开关关闭时既不能写入、也不能被读取。
 * 这类约束必须由服务层强制，而不是靠调用方自觉——否则漏改一处就绕过。
 *
 * 测试全部在临时配置目录内进行，不触碰 ~/.gravitas/。
 */

let tempDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'telemetry-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

/** 每个用例重新 import，避免模块级缓存串味 */
async function loadService() {
  return import(`./telemetry-service?t=${Math.random()}`)
}

describe('采集设置默认值', () => {
  test('被动采集默认开启、情绪打卡默认关闭', async () => {
    const svc = await loadService()
    const settings = svc.getTelemetrySettings()
    expect(settings.enabled.knowledge).toBe(true)
    expect(settings.enabled.focus).toBe(true)
    expect(settings.enabled.collaboration).toBe(true)
    expect(settings.enabled.emotion).toBe(false)
  })

  test('保留期默认 180 天', async () => {
    const svc = await loadService()
    expect(svc.getTelemetrySettings().retentionDays).toBe(180)
  })

  test('设置可持久化并读回', async () => {
    const svc = await loadService()
    svc.updateTelemetrySettings({ enabled: { emotion: true }, retentionDays: 30 })
    const settings = svc.getTelemetrySettings()
    expect(settings.enabled.emotion).toBe(true)
    expect(settings.retentionDays).toBe(30)
  })
})

describe('被动事件写入', () => {
  test('知识事件在开关开启时写入成功', async () => {
    const svc = await loadService()
    const ok = svc.recordEvent({
      category: 'knowledge',
      type: 'note_opened',
      meta: { noteId: 'n1' },
    })
    expect(ok).toBe(true)
    expect(svc.readTelemetryEvents()).toHaveLength(1)
  })

  test('关闭的类别拒绝写入', async () => {
    const svc = await loadService()
    svc.updateTelemetrySettings({ enabled: { knowledge: false } })
    const ok = svc.recordEvent({ category: 'knowledge', type: 'note_opened' })
    expect(ok).toBe(false)
    expect(svc.readTelemetryEvents()).toHaveLength(0)
  })

  test('写入失败不抛错（埋点是旁路观测）', async () => {
    const svc = await loadService()
    // 构造极端输入也不应抛出
    expect(() =>
      svc.recordEvent({ category: 'focus', type: 'tool_invoked', value: Number.NaN }),
    ).not.toThrow()
  })

  test('meta 中的超长字符串被截断', async () => {
    const svc = await loadService()
    const long = 'x'.repeat(500)
    svc.recordEvent({ category: 'knowledge', type: 'note_opened', meta: { noteId: long } })
    const events = svc.readTelemetryEvents()
    expect(String(events[0]?.meta?.noteId).length).toBe(200)
  })

  test('meta 中的嵌套对象被丢弃', async () => {
    const svc = await loadService()
    svc.recordEvent({
      category: 'knowledge',
      type: 'note_opened',
      // 故意传入非法类型，模拟调用方误把正文塞进来
      meta: { noteId: 'n1', content: { body: '正文不该被存' } } as never,
    })
    const events = svc.readTelemetryEvents()
    expect(events[0]?.meta?.noteId).toBe('n1')
    expect(events[0]?.meta?.content).toBeUndefined()
  })
})

describe('情绪数据的隐私边界', () => {
  test('开关关闭时拒绝写入情绪事件', async () => {
    const svc = await loadService()
    const ok = svc.recordEvent({ category: 'emotion', type: 'mood_logged', value: 4 })
    expect(ok).toBe(false)
    expect(svc.readSensitiveEvents()).toHaveLength(0)
  })

  test('开关关闭时 logMood 抛明确错误而非静默丢弃', async () => {
    const svc = await loadService()
    expect(() => svc.logMood({ score: 4 })).toThrow('未开启')
  })

  test('开关开启后可写入与读取', async () => {
    const svc = await loadService()
    svc.updateTelemetrySettings({ enabled: { emotion: true } })
    svc.logMood({ score: 4, tags: ['专注'] })
    const events = svc.readSensitiveEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.value).toBe(4)
  })

  test('关闭后即使有历史数据也读不到（读取路径同样生效）', async () => {
    const svc = await loadService()
    svc.updateTelemetrySettings({ enabled: { emotion: true } })
    svc.logMood({ score: 5 })
    expect(svc.readSensitiveEvents()).toHaveLength(1)

    svc.updateTelemetrySettings({ enabled: { emotion: false } })
    // 文件仍在，但开关关闭时读取返回空
    expect(svc.readSensitiveEvents()).toHaveLength(0)
    expect(existsSync(join(tempDir, 'telemetry-mood', 'events.jsonl'))).toBe(true)
  })

  test('分值越界被拒绝', async () => {
    const svc = await loadService()
    svc.updateTelemetrySettings({ enabled: { emotion: true } })
    expect(() => svc.logMood({ score: 0 })).toThrow('1 到 5')
    expect(() => svc.logMood({ score: 6 })).toThrow('1 到 5')
    expect(() => svc.logMood({ score: Number.NaN })).toThrow('1 到 5')
  })

  test('普通与敏感事件写入不同文件', async () => {
    const svc = await loadService()
    svc.updateTelemetrySettings({ enabled: { emotion: true } })
    svc.recordEvent({ category: 'knowledge', type: 'note_opened', meta: { noteId: 'n1' } })
    svc.logMood({ score: 3 })

    expect(existsSync(join(tempDir, 'telemetry', 'events.jsonl'))).toBe(true)
    expect(existsSync(join(tempDir, 'telemetry-mood', 'events.jsonl'))).toBe(true)

    // 普通文件里不应出现情绪事件
    const normal = readFileSync(join(tempDir, 'telemetry', 'events.jsonl'), 'utf-8')
    expect(normal).not.toContain('mood_logged')
  })
})

describe('单行损坏容错', () => {
  test('损坏行被跳过，其余事件仍可读', async () => {
    const svc = await loadService()
    svc.recordEvent({ category: 'knowledge', type: 'note_opened', meta: { noteId: 'n1' } })

    // 手动追加一行损坏数据（模拟写入中断）
    const path = join(tempDir, 'telemetry', 'events.jsonl')
    writeFileSync(path, `${readFileSync(path, 'utf-8')}{ 这不是合法 JSON\n`, 'utf-8')

    const events = svc.readTelemetryEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.meta?.noteId).toBe('n1')
  })

  test('缺关键字段的行被跳过', async () => {
    const svc = await loadService()
    svc.recordEvent({ category: 'knowledge', type: 'note_opened', meta: { noteId: 'n1' } })
    const path = join(tempDir, 'telemetry', 'events.jsonl')
    writeFileSync(
      path,
      `${readFileSync(path, 'utf-8')}${JSON.stringify({ category: 'knowledge' })}\n`,
      'utf-8',
    )
    expect(svc.readTelemetryEvents()).toHaveLength(1)
  })
})

describe('统计与聚合', () => {
  test('统计反映事件条数与时间范围', async () => {
    const svc = await loadService()
    svc.recordEvent({ category: 'knowledge', type: 'note_opened', meta: { noteId: 'n1' } })
    svc.recordEvent({ category: 'focus', type: 'tool_invoked' })

    const stats = svc.getTelemetryStats()
    expect(stats.eventCount).toBe(2)
    expect(stats.eventBytes).toBeGreaterThan(0)
    expect(stats.oldestAt).toBeDefined()
    expect(stats.newestAt).toBeDefined()
  })

  test('敏感数据量独立统计', async () => {
    const svc = await loadService()
    svc.updateTelemetrySettings({ enabled: { emotion: true } })
    svc.recordEvent({ category: 'knowledge', type: 'note_opened', meta: { noteId: 'n1' } })
    svc.logMood({ score: 4 })

    const stats = svc.getTelemetryStats()
    expect(stats.eventCount).toBe(1)
    expect(stats.sensitive.count).toBe(1)
  })

  test('总览聚合普通事件', async () => {
    const svc = await loadService()
    svc.recordEvent({ category: 'knowledge', type: 'note_opened', meta: { noteId: 'n1' } })
    svc.recordEvent({ category: 'focus', type: 'session_finished', value: 600 })

    const overview = svc.getTelemetryOverview()
    expect(overview.totalEvents).toBe(2)
    expect(overview.categoryTotals.knowledge).toBe(1)
    expect(overview.categoryTotals.focus).toBe(1)
    expect(overview.daily[0]?.focusSeconds).toBe(600)
  })

  test('开关关闭时总览不包含情绪数据', async () => {
    const svc = await loadService()
    svc.updateTelemetrySettings({ enabled: { emotion: true } })
    svc.logMood({ score: 4 })
    expect(svc.getTelemetryOverview().categoryTotals.emotion).toBe(1)

    svc.updateTelemetrySettings({ enabled: { emotion: false } })
    expect(svc.getTelemetryOverview().categoryTotals.emotion).toBe(0)
  })
})

describe('数据清理', () => {
  test('clearAll 清空普通与敏感数据', async () => {
    const svc = await loadService()
    svc.updateTelemetrySettings({ enabled: { emotion: true } })
    svc.recordEvent({ category: 'knowledge', type: 'note_opened', meta: { noteId: 'n1' } })
    svc.logMood({ score: 4 })

    svc.clearTelemetry()
    expect(svc.readTelemetryEvents()).toHaveLength(0)
    expect(svc.readSensitiveEvents()).toHaveLength(0)
  })

  test('clearSensitive 只清敏感数据，保留普通事件', async () => {
    const svc = await loadService()
    svc.updateTelemetrySettings({ enabled: { emotion: true } })
    svc.recordEvent({ category: 'knowledge', type: 'note_opened', meta: { noteId: 'n1' } })
    svc.logMood({ score: 4 })

    svc.clearSensitiveTelemetry()
    expect(svc.readSensitiveEvents()).toHaveLength(0)
    expect(svc.readTelemetryEvents()).toHaveLength(1)
  })

  test('保留期清理移除超期事件', async () => {
    const svc = await loadService()
    // 手工写入一条 400 天前的事件
    const ancient = new Date(Date.now() - 400 * 86_400_000)
    const event = {
      id: 'old-1',
      category: 'knowledge',
      type: 'note_opened',
      at: ancient.toISOString(),
    }
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(tempDir, 'telemetry'), { recursive: true })
    writeFileSync(
      join(tempDir, 'telemetry', 'events.jsonl'),
      `${JSON.stringify(event)}\n`,
      'utf-8',
    )

    const result = svc.pruneAll(180)
    expect(result.removed).toBe(1)
    expect(svc.readTelemetryEvents()).toHaveLength(0)
  })

  test('retentionDays 为 0 时不清理', async () => {
    const svc = await loadService()
    const ancient = new Date(Date.now() - 400 * 86_400_000)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(tempDir, 'telemetry'), { recursive: true })
    writeFileSync(
      join(tempDir, 'telemetry', 'events.jsonl'),
      `${JSON.stringify({ id: 'old', category: 'knowledge', type: 'note_opened', at: ancient.toISOString() })}\n`,
      'utf-8',
    )

    const result = svc.pruneAll(0)
    expect(result.removed).toBe(0)
    expect(svc.readTelemetryEvents()).toHaveLength(1)
  })
})

describe('打卡记录回显', () => {
  test('开关关闭时列表为空', async () => {
    const svc = await loadService()
    svc.updateTelemetrySettings({ enabled: { emotion: true } })
    svc.logMood({ score: 4 })
    svc.updateTelemetrySettings({ enabled: { emotion: false } })
    expect(svc.listRecentMood()).toHaveLength(0)
  })

  test('开关开启时按时间倒序返回', async () => {
    const svc = await loadService()
    svc.updateTelemetrySettings({ enabled: { emotion: true } })
    svc.logMood({ score: 3 })
    svc.logMood({ score: 5 })

    const list = svc.listRecentMood()
    expect(list).toHaveLength(2)
    // 最新的在前
    expect(list[0]!.at >= list[1]!.at).toBe(true)
  })
})
