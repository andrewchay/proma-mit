/**
 * Companion Web Push（M3-3）
 *
 * - VAPID 密钥对首次使用时生成并持久化到 settings.companionServer；
 * - 手机订阅保存到 ~/.gravitas/companion-push/subscriptions.json；
 * - 权限请求 / AskUser 请求触发推送（配对 token 之外的"人不在电脑前"场景）。
 *
 * 安全与边界：
 * - 推送仅含标题/摘要/跳转地址，不含工具输入、消息正文；
 * - 订阅端点失效（404/410）时自动清理；
 * - 浏览器侧要求 HTTPS 安全上下文（建议 Tailscale Serve），HTTP 局域网下页面优雅降级。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import webpush from 'web-push'
import { getConfigDir } from './config-paths'
import { getSettings, updateSettings } from './settings-service'

/** 手机端推送订阅（Web Push 协议标准结构） */
export interface CompanionPushSubscription {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}

const SUBSCRIPTIONS_DIR = 'companion-push'

function subscriptionsPath(): string {
  return join(getConfigDir(), SUBSCRIPTIONS_DIR, 'subscriptions.json')
}

/** 获取（或首次生成）VAPID 密钥对 */
export function ensureVapidKeys(): { publicKey: string; privateKey: string } {
  const settings = getSettings().companionServer
  if (settings?.vapidPublicKey && settings?.vapidPrivateKey) {
    return { publicKey: settings.vapidPublicKey, privateKey: settings.vapidPrivateKey }
  }
  const keys = webpush.generateVAPIDKeys()
  updateSettings({ companionServer: { vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey } })
  return { publicKey: keys.publicKey, privateKey: keys.privateKey }
}

function loadSubscriptions(): CompanionPushSubscription[] {
  const path = subscriptionsPath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveSubscriptions(list: CompanionPushSubscription[]): void {
  const path = subscriptionsPath()
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(list, null, 2), 'utf8')
}

function isValidSubscription(value: unknown): value is CompanionPushSubscription {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  return (
    typeof v.endpoint === 'string' &&
    v.endpoint.startsWith('https://') &&
    typeof v.keys?.p256dh === 'string' &&
    typeof v.keys?.auth === 'string'
  )
}

/** 新增订阅（同一 endpoint 去重） */
export function addPushSubscription(subscription: unknown): boolean {
  if (!isValidSubscription(subscription)) return false
  const list = loadSubscriptions().filter((s) => s.endpoint !== subscription.endpoint)
  list.push(subscription)
  saveSubscriptions(list)
  return true
}

/** 按 endpoint 移除订阅 */
export function removePushSubscription(endpoint: string): boolean {
  const list = loadSubscriptions()
  const next = list.filter((s) => s.endpoint !== endpoint)
  const removed = next.length !== list.length
  if (removed) saveSubscriptions(next)
  return removed
}

/** 发送函数类型（测试可注入 fake） */
export type PushSender = (subscription: CompanionPushSubscription, payload: { title: string; body: string; url: string }) => Promise<void>

/** 默认发送：web-push + VAPID；失效清理由 sendCompanionPush 统一处理 */
export const defaultPushSender: PushSender = async (subscription, payload) => {
  const { publicKey, privateKey } = ensureVapidKeys()
  await webpush.sendNotification(subscription, JSON.stringify(payload), {
    vapidDetails: { subject: 'mailto:companion@gravitas.app', publicKey, privateKey },
  })
}

/** 向全部订阅推送通知；失效订阅（404/410）自动清理；单条失败不影响其他订阅 */
export async function sendCompanionPush(
  title: string,
  body: string,
  options: { url?: string; sender?: PushSender } = {},
): Promise<void> {
  const list = loadSubscriptions()
  if (list.length === 0) return
  const payload = { title, body, url: options.url ?? '/companion' }
  const sender = options.sender ?? defaultPushSender
  await Promise.allSettled(
    list.map(async (sub) => {
      try {
        await sender(sub, payload)
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode
        if (statusCode === 404 || statusCode === 410) {
          removePushSubscription(sub.endpoint)
          return
        }
        throw error
      }
    }),
  )
}

/** 测试专用：清空订阅文件 */
export function _resetPushStoreForTest(): void {
  const path = subscriptionsPath()
  if (existsSync(path)) writeFileSync(path, '[]', 'utf8')
}
