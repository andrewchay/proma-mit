import { describe, expect, test } from 'bun:test'
import { extractCompactBoundaryInfo } from './compact-boundary-info'
import type { SDKMessage } from '@gravitas/shared'

describe('压缩边界信息提取', () => {
  test('Gravitas 压缩边界：摘要、条数与归档标记齐全', () => {
    const message = {
      type: 'system',
      subtype: 'compact_boundary',
      summary: '用户要求重构登录模块，已完成接口拆分。',
      compactionSource: { messageCount: 42, sha256: 'abc', archiveFile: '1728-x.jsonl' },
    } as unknown as SDKMessage
    expect(extractCompactBoundaryInfo(message)).toEqual({
      summary: '用户要求重构登录模块，已完成接口拆分。',
      compactedCount: 42,
      archived: true,
    })
  })

  test('SDK 原生压缩边界缺少负载时全部容错为 null/false', () => {
    const message = { type: 'system', subtype: 'compact_boundary' } as unknown as SDKMessage
    expect(extractCompactBoundaryInfo(message)).toEqual({
      summary: null,
      compactedCount: null,
      archived: false,
    })
  })

  test('空字符串摘要视为无摘要', () => {
    const message = {
      type: 'system',
      subtype: 'compact_boundary',
      summary: '   ',
      compactionSource: { messageCount: 0 },
    } as unknown as SDKMessage
    expect(extractCompactBoundaryInfo(message).summary).toBeNull()
  })
})
