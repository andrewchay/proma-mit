/**
 * 权益门禁 —— 判断某个订阅能力当前是否可用
 *
 * 这是**权限判定的唯一入口**。此前 marketing 与 academic 插件各自复制了
 * 一份验签逻辑，knowledge-pro 若再抄一次就成了三份。重复的风险不在于啰嗦，
 * 而在于「某次安全修复只改了一处」——门禁被削弱却不自知。
 *
 * 判定链（任一失败即拒绝，fail-closed）：
 *   1. 存在缓存的权益快照
 *   2. 快照签名通过公钥验证（打包环境不接受 dev 伪签名）
 *   3. 订阅状态为 active 或 grace（未过期）
 *   4. 快照的 capabilities 确实包含目标能力
 *
 * 任何异常一律返回 false：读取失败不能变成放行。
 */

import type { EntitlementSnapshot, SubscriptionCapabilityId } from '@gravitas/shared'

/**
 * 检查指定能力当前是否授予。
 *
 * 用 require 延迟加载依赖：这些模块会经由 settings-service 读到 Electron
 * 的 safeStorage 路径，在模块初始化期直接 import 可能形成循环依赖。
 */
export function hasCapability(capability: SubscriptionCapabilityId): boolean {
  try {
    const { EntitlementCache } = require('./subscription/entitlement-cache') as {
      EntitlementCache: new () => { load: () => { snapshot: EntitlementSnapshot } | undefined }
    }
    const { verifyEntitlementSnapshotSignature } = require('./subscription/entitlement-signature') as {
      verifyEntitlementSnapshotSignature: (
        snapshot: EntitlementSnapshot,
        publicKeyPem: string,
        options?: { allowDevSignature?: boolean },
      ) => { ok: boolean }
    }
    const { canUseCapability, getEntitlementStatus } = require('@gravitas/shared') as {
      canUseCapability: (
        snapshot: EntitlementSnapshot | null,
        capability: string,
        now: Date,
      ) => boolean
      getEntitlementStatus: (snapshot: EntitlementSnapshot, now: Date) => string
    }

    const cached = new EntitlementCache().load()
    if (!cached?.snapshot) return false

    const publicKeyPem = process.env.GRAVITAS_SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM ?? ''
    // 打包后必须严格验签；开发环境允许 dev 签名以便本地调试
    const allowDevSignature = !(require('electron') as { app?: { isPackaged?: boolean } }).app
      ?.isPackaged

    const verified = verifyEntitlementSnapshotSignature(cached.snapshot, publicKeyPem, {
      allowDevSignature,
    })
    if (!verified.ok) return false

    const now = new Date()
    const status = getEntitlementStatus(cached.snapshot, now)
    if (status !== 'active' && status !== 'grace') return false

    return canUseCapability(cached.snapshot, capability, now)
  } catch {
    // 任何异常都按无权益处理（fail-closed），不因为读取失败而放行
    return false
  }
}

/**
 * 断言能力可用，否则抛错。
 *
 * 供「用户显式操作」的路径使用（如点击保存笔记、创建论文）。这类场景
 * 静默失败会让用户困惑——他点了按钮却什么都没发生。工具注入等静默路径
 * 应直接用 hasCapability 返回空数组。
 *
 * 免费能力（FREE_CAPABILITIES）直接放行，不要求权益快照。
 */
export function assertCapability(capability: SubscriptionCapabilityId, action: string): void {
  const { isFreeCapability } = require('@gravitas/shared') as {
    isFreeCapability: (capability: SubscriptionCapabilityId) => boolean
  }
  if (isFreeCapability(capability)) return
  if (!hasCapability(capability)) {
    throw new Error(`${action}需要订阅权益（${capability}），请先在「订阅与账户」中开通或检查订阅状态`)
  }
}
