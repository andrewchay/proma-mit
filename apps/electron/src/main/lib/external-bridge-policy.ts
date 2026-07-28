/** 外部 IM 入口的最小权限决策，供不同 Bridge 共享并单独回归。 */

import type { PromaPermissionMode } from '@proma/shared'

export function resolveExternalBridgePermissionMode(trustedSender: boolean): Extract<PromaPermissionMode, 'safe' | 'bypassPermissions'> {
  return trustedSender ? 'bypassPermissions' : 'safe'
}
