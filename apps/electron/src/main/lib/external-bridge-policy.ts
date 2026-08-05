/** 外部 IM 入口统一走 auto；身份白名单不能绕过逐次动作审批。 */

import type { PromaPermissionMode } from '@gravitas/shared'

export function resolveExternalBridgePermissionMode(_trustedSender: boolean): Extract<PromaPermissionMode, 'auto'> {
  return 'auto'
}
