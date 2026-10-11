import { describe, expect, test } from 'bun:test'
import { resolveBatchAllowPlan, requiresPerActionApprovalTool, extractBaseCommand } from './permission-batch'
import type { PermissionRequest } from '@gravitas/shared'

/** 构造最小可用的权限请求 */
function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: overrides.requestId ?? Math.random().toString(36).slice(2),
    sessionId: 's1',
    toolName: 'Read',
    toolInput: {},
    description: '',
    dangerLevel: 'normal',
    ...overrides,
  }
}

describe('权限批量审批 —— 可批量段计算', () => {
  test('不足 2 条请求时不提供批量', () => {
    expect(resolveBatchAllowPlan([makeRequest()])).toBeNull()
    expect(resolveBatchAllowPlan([])).toBeNull()
  })

  test('同工具同等级的连续段可批量，含队首', () => {
    const requests = [
      makeRequest({ requestId: 'r1' }),
      makeRequest({ requestId: 'r2' }),
      makeRequest({ requestId: 'r3' }),
    ]
    expect(resolveBatchAllowPlan(requests)).toEqual({
      requestIds: ['r1', 'r2', 'r3'],
      remainingCount: 0,
    })
  })

  test('遇到不同工具时截断，其后请求保留逐个处理', () => {
    const requests = [
      makeRequest({ requestId: 'r1', toolName: 'Read' }),
      makeRequest({ requestId: 'r2', toolName: 'Read' }),
      makeRequest({ requestId: 'r3', toolName: 'Edit' }),
      makeRequest({ requestId: 'r4', toolName: 'Edit' }),
    ]
    expect(resolveBatchAllowPlan(requests)).toEqual({
      requestIds: ['r1', 'r2'],
      remainingCount: 2,
    })
  })

  test('危险等级请求一律不批量', () => {
    const requests = [
      makeRequest({ requestId: 'r1', dangerLevel: 'dangerous' }),
      makeRequest({ requestId: 'r2', dangerLevel: 'dangerous' }),
    ]
    expect(resolveBatchAllowPlan(requests)).toBeNull()
  })

  test('safe 与 normal 混合时不批量（等级不一致即截断）', () => {
    const requests = [
      makeRequest({ requestId: 'r1', dangerLevel: 'safe' }),
      makeRequest({ requestId: 'r2', dangerLevel: 'normal' }),
    ]
    expect(resolveBatchAllowPlan(requests)).toBeNull()
  })

  test('Bash 仅同命令族可批量', () => {
    const requests = [
      makeRequest({ requestId: 'r1', toolName: 'Bash', command: 'ls -la' }),
      makeRequest({ requestId: 'r2', toolName: 'Bash', command: 'ls src' }),
      makeRequest({ requestId: 'r3', toolName: 'Bash', command: 'git status' }),
    ]
    expect(resolveBatchAllowPlan(requests)).toEqual({
      requestIds: ['r1', 'r2'],
      remainingCount: 1,
    })
  })

  test('Bash 段内出现危险命令时停止扩展', () => {
    const requests = [
      makeRequest({ requestId: 'r1', toolName: 'Bash', command: 'ls -la' }),
      makeRequest({ requestId: 'r2', toolName: 'Bash', command: 'rm -rf build' }),
      makeRequest({ requestId: 'r3', toolName: 'Bash', command: 'ls src' }),
    ]
    // r1 单独不可批量（段长不足 2），且 r2 必须逐个确认
    expect(resolveBatchAllowPlan(requests)).toBeNull()
  })

  test('逐次确认类工具（Computer Use / 上传下载）不批量', () => {
    for (const tool of ['ComputerUseClick', 'WebBridgeDownload', 'WebBridgeUpload']) {
      const requests = [makeRequest({ toolName: tool }), makeRequest({ toolName: tool })]
      expect(resolveBatchAllowPlan(requests)).toBeNull()
    }
    expect(requiresPerActionApprovalTool('ComputerUseStatus')).toBe(false)
  })
})

describe('权限批量审批 —— 命令族提取', () => {
  test('取命令首个 token，忽略前导空白', () => {
    expect(extractBaseCommand('  git status')).toBe('git')
    expect(extractBaseCommand('ls -la /tmp')).toBe('ls')
  })
})
