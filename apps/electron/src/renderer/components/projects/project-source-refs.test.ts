import { describe, expect, test } from 'bun:test'
import {
  emptySourceRef,
  formatSourceRef,
  parseSourceRefs,
  validateSourceRef,
  validateSourceRefs,
} from './project-source-refs'
import type { ProjectDecisionSourceRef } from '@gravitas/shared'

describe('决策来源行辅助（R-P0-01）', () => {
  test('完整行解析出四个字段', () => {
    expect(parseSourceRefs('task | TASK-1 | section:1 | abc123')).toEqual([
      { sourceType: 'task', sourceId: 'TASK-1', locator: 'section:1', checksum: 'abc123' },
    ])
  })

  test('缺少 checksum 仍可解析；空行被忽略', () => {
    expect(parseSourceRefs('meeting | m-1 | paragraph:42\n\n')).toEqual([
      { sourceType: 'meeting', sourceId: 'm-1', locator: 'paragraph:42' },
    ])
  })

  test('格式化往返保持字段', () => {
    const ref: ProjectDecisionSourceRef = { sourceType: 'task', sourceId: 'T1', locator: 'section:2' }
    expect(parseSourceRefs(formatSourceRef(ref))).toEqual([ref])
  })

  test('legacy 行原样保留，不被改写', () => {
    const parsed = parseSourceRefs('旧的自由文本依据')
    expect(parsed[0]?.sourceType).toBe('legacy')
    expect(formatSourceRef(parsed[0]!)).toBe('旧的自由文本依据')
  })

  test('空行（legacy 之外）逐字段报错，错误含字段名与示例', () => {
    const errors = validateSourceRef(emptySourceRef())
    expect(errors.sourceId).toContain('来源 ID')
    expect(errors.locator).toContain('原文定位')
    expect(errors.sourceType).toBeUndefined()
  })

  test('非法类型给出可选值清单', () => {
    const errors = validateSourceRef({ sourceType: 'unknown' as never, sourceId: 'X', locator: 'p:1' })
    expect(errors.sourceType).toContain('task / document / meeting / message / url / other')
  })

  test('validateSourceRefs 汇总行级错误；全部合法返回 null', () => {
    const bad = validateSourceRefs([emptySourceRef(), { sourceType: 'task', sourceId: 'T', locator: 's:1' }])
    expect(bad).not.toBeNull()
    expect(Object.keys(bad![0]!)).toEqual(['sourceId', 'locator'])
    expect(validateSourceRefs([{ sourceType: 'url', sourceId: 'https://a.b', locator: 'line:3' }])).toBeNull()
  })
})
