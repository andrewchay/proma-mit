/**
 * 本地租户上下文
 *
 * 为 Gravitas 开源版（Electron 桌面应用）提供默认租户上下文，
 * 使得单机版数据可以无缝迁移到服务端多租户架构。
 *
 * 设计原则：
 * - 开源版默认使用 'local' 租户，用户 ID 从用户档案读取
 * - 所有数据操作自动注入 tenantId/userId，无需改动现有业务逻辑
 * - 迁移到服务端时，只需替换 scope 的生成方式
 */

import type { AgentRuntimeScope, AgentRuntimeRole } from '@gravitas/shared'

const DEFAULT_TENANT_ID = 'local'
const DEFAULT_USER_ID = 'default'
const DEFAULT_ROLES: AgentRuntimeRole[] = ['admin']

/** 用户档案服务引用（延迟初始化，避免循环依赖） */
let _userProfileGetter: (() => { userName?: string }) | undefined

export function setLocalTenantUserProfileGetter(getter: () => { userName?: string }): void {
  _userProfileGetter = getter
}

/**
 * 获取当前本地租户上下文
 *
 * 开源版 Electron 使用此函数生成 AgentRuntimeScope，
 * 所有数据自动归入 'local' 租户。
 */
export function getLocalTenantScope(): AgentRuntimeScope {
  const userProfile = _userProfileGetter?.()
  return {
    tenantId: DEFAULT_TENANT_ID,
    userId: userProfile?.userName || DEFAULT_USER_ID,
    roles: [...DEFAULT_ROLES],
  }
}

/**
 * 创建带本地租户上下文的完整对象
 *
 * 将任意数据对象与本地租户 scope 合并，用于兼容服务端接口。
 */
export function withLocalTenantScope<T extends Record<string, unknown>>(data: T): T & AgentRuntimeScope {
  return { ...data, ...getLocalTenantScope() }
}

/**
 * 检查当前是否处于本地租户模式
 */
export function isLocalTenant(scope: AgentRuntimeScope): boolean {
  return scope.tenantId === DEFAULT_TENANT_ID
}

/**
 * 本地租户配置常量
 */
export const LOCAL_TENANT_CONFIG = {
  tenantId: DEFAULT_TENANT_ID,
  defaultUserId: DEFAULT_USER_ID,
  defaultRoles: DEFAULT_ROLES,
  /** 本地租户是否启用审计日志写入 */
  enableAudit: true,
  /** 本地租户审计日志路径 */
  auditPath: 'config-audit/events.jsonl',
} as const
