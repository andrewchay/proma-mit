import { describe, expect, test } from 'bun:test'
import { resolveExternalBridgePermissionMode } from './external-bridge-policy'

describe('外部 IM 权限策略', () => {
  test('given an untrusted sender when handling a bridge message then it uses safe mode', () => {
    expect(resolveExternalBridgePermissionMode(false)).toBe('safe')
  })

  test('given an explicitly trusted sender when handling a bridge message then it may use bypassPermissions', () => {
    expect(resolveExternalBridgePermissionMode(true)).toBe('bypassPermissions')
  })
})
