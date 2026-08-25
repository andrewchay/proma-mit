/**
 * 服务端无鉴权模式支持
 *
 * authMode='none' 时：
 * - 所有请求自动授予默认租户上下文
 * - 所有操作允许（admin 角色）
 * - 数据归入单一默认租户
 *
 * 这是企业版试用/私有部署的降级模式，降低使用门槛。
 */

import type { AgentRuntimeScope, AgentRuntimeWebAuthResolver } from '@gravitas/shared'

const DEFAULT_NONE_AUTH_TENANT_ID = 'default'
const DEFAULT_NONE_AUTH_USER_ID = 'anonymous'
const DEFAULT_NONE_AUTH_ROLES = ['admin', 'operator', 'security-auditor'] as const

/**
 * 创建无鉴权模式的 scope 生成器
 *
 * 所有请求自动获得默认租户上下文，无需登录。
 */
export function createNoneAuthScope(): AgentRuntimeScope {
  return {
    tenantId: DEFAULT_NONE_AUTH_TENANT_ID,
    userId: DEFAULT_NONE_AUTH_USER_ID,
    roles: [...DEFAULT_NONE_AUTH_ROLES],
  }
}

/**
 * 无鉴权模式 resolver
 *
 * 直接返回默认 scope，不检查任何凭据。
 */
export function createNoneAuthResolver(): AgentRuntimeWebAuthResolver {
  return async () => createNoneAuthScope()
}

/**
 * 检查当前是否使用无鉴权模式
 */
export function isNoneAuthScope(scope: AgentRuntimeScope): boolean {
  return scope.tenantId === DEFAULT_NONE_AUTH_TENANT_ID
}
