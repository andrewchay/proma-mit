/**
 * 飞书审批卡片纯函数测试：票拟卡构建 / 按钮值解析 / 结果卡回写
 */

import { describe, expect, test } from 'bun:test'
import {
  APPROVAL_CARD_ACTION_KEY,
  buildApprovalResultCard,
  buildApprovalStaleCard,
  buildPermissionApprovalCard,
  parseApprovalCardAction,
} from './feishu-approval-cards'
import type { PermissionRequest } from '@gravitas/shared'

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'req-123',
    sessionId: 'session-abcdef-1234',
    toolName: 'Bash',
    toolInput: { command: 'rm -rf /tmp/build' },
    description: '删除构建产物目录',
    dangerLevel: 'dangerous',
    ...overrides,
  }
}

describe('飞书审批卡片', () => {
  test('票拟卡：高危请求红色头 + 允许/拒绝按钮 + 按钮值带 requestId', () => {
    const card = buildPermissionApprovalCard(makeRequest()) as {
      header: { template: string; title: { content: string } }
      elements: Array<Record<string, unknown>>
    }
    expect(card.header.template).toBe('red')
    expect(card.header.title.content).toContain('高危')

    const actionElement = card.elements.find((el) => el.tag === 'action') as {
      actions: Array<{ value: Record<string, unknown>; type: string }>
    }
    expect(actionElement.actions).toHaveLength(2)
    const [allow, deny] = actionElement.actions
    expect(allow!.type).toBe('primary')
    expect(deny!.type).toBe('danger')
    const parsedAllow = parseApprovalCardAction(allow!.value)
    expect(parsedAllow).toEqual({ kind: 'permission', requestId: 'req-123', decision: 'allow' })
    const parsedDeny = parseApprovalCardAction(deny!.value)
    expect(parsedDeny).toEqual({ kind: 'permission', requestId: 'req-123', decision: 'deny' })
  })

  test('票拟卡：安全请求绿色头，Bash 命令进入代码块，超长输入被截断', () => {
    const longInput: Record<string, unknown> = { data: 'x'.repeat(2000) }
    const card = buildPermissionApprovalCard(
      makeRequest({ dangerLevel: 'safe', command: 'echo hi', toolInput: longInput }),
    ) as { header: { template: string }; elements: Array<{ tag: string; text?: { content: string } }> }
    expect(card.header.template).toBe('green')

    const div = card.elements.find((el) => el.tag === 'div') as { text: { content: string } }
    expect(div.text.content).toContain('echo hi')
    expect(div.text.content.length).toBeLessThan(2000)
  })

  test('parseApprovalCardAction：非审批按钮/非法载荷一律返回 null', () => {
    expect(parseApprovalCardAction(undefined)).toBeNull()
    expect(parseApprovalCardAction('text')).toBeNull()
    expect(parseApprovalCardAction({ action: 'goto' })).toBeNull()
    expect(parseApprovalCardAction({ [APPROVAL_CARD_ACTION_KEY]: { kind: 'other' } })).toBeNull()
    expect(parseApprovalCardAction({ [APPROVAL_CARD_ACTION_KEY]: { kind: 'permission' } })).toBeNull()
    expect(parseApprovalCardAction({ [APPROVAL_CARD_ACTION_KEY]: { kind: 'permission', requestId: '', decision: 'allow' } })).toBeNull()
    expect(
      parseApprovalCardAction({ [APPROVAL_CARD_ACTION_KEY]: { kind: 'permission', requestId: 'r1', decision: 'maybe' } }),
    ).toBeNull()
  })

  test('批红结果卡：允许=绿色、拒绝=灰色，含操作人与回写说明', () => {
    const request = makeRequest()
    const allowed = buildApprovalResultCard(request, 'allow', '张三') as {
      header: { template: string; title: { content: string } }
      elements: Array<{ tag: string; text?: { content: string } }>
    }
    expect(allowed.header.template).toBe('green')
    const div = allowed.elements.find((el) => el.tag === 'div') as { text: { content: string } }
    expect(div.text.content).toContain('张三')
    expect(JSON.stringify(allowed)).toContain('session-abcd')

    const denied = buildApprovalResultCard(request, 'deny', undefined) as { header: { template: string } }
    expect(denied.header.template).toBe('grey')
  })

  test('失效提示卡：灰色头 + 未生效说明', () => {
    const card = buildApprovalStaleCard('allow') as { header: { template: string }; elements: Array<{ text?: { content: string } }> }
    expect(card.header.template).toBe('grey')
    expect(JSON.stringify(card)).toContain('未生效')
  })
})
