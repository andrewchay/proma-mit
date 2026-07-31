import { describe, expect, test } from 'bun:test'
import { resolveExternalBridgePermissionMode } from './external-bridge-policy'

describe('外部 IM 权限策略', () => {
  test('given an untrusted sender when handling a bridge message then it uses auto mode', () => {
    expect(resolveExternalBridgePermissionMode(false)).toBe('auto')
  })

  test('given an explicitly trusted sender when handling a bridge message then it still cannot bypass approvals', () => {
    expect(resolveExternalBridgePermissionMode(true)).toBe('auto')
  })
})
