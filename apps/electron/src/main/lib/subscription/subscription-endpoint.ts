import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getSubscriptionConfigPath } from '../config-paths'

/**
 * 订阅服务地址解析。
 *
 * 分发场景的问题：此前地址硬编码为 `http://localhost:4310`，
 * 而用户机器上并不存在订阅服务，导致付费功能全部失败且用户无法修改。
 *
 * 解析优先级（从高到低）：
 * 1. 用户在设置中填写并保存到本地的地址
 * 2. 打包时注入的环境变量 GRAVITAS_SUBSCRIPTION_SERVICE_URL
 * 3. 构建期写入的默认地址（由 GRAVITAS_SUBSCRIPTION_DEFAULT_URL 决定）
 *
 * 若三者都没有，返回 undefined。此时 UI 应明确告知「服务未配置」，
 * 而不是静默失败成「未订阅」。
 */

export interface SubscriptionEndpointConfig {
  /** 用户自定义地址（最高优先级） */
  userOverrideUrl?: string
}

let cachedUserOverride: string | undefined
let userOverrideLoaded = false

function isUsableUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 读取用户保存的自定义地址 */
function loadUserOverride(): string | undefined {
  if (userOverrideLoaded) return cachedUserOverride
  userOverrideLoaded = true

  try {
    const path = getSubscriptionConfigPath()
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SubscriptionEndpointConfig
    if (isUsableUrl(parsed.userOverrideUrl)) {
      cachedUserOverride = parsed.userOverrideUrl
      return cachedUserOverride
    }
  } catch {
    // 配置文件损坏时忽略，回退到环境变量
  }
  return undefined
}

/** 保存用户自定义地址。传入空字符串表示清除自定义。 */
export function setUserSubscriptionUrl(url: string): void {
  const trimmed = url.trim()
  const path = getSubscriptionConfigPath()
  mkdirSync(dirname(path), { recursive: true })

  if (!trimmed) {
    writeFileSync(path, JSON.stringify({}, null, 2), { mode: 0o600 })
    cachedUserOverride = undefined
    userOverrideLoaded = true
    return
  }

  if (!isUsableUrl(trimmed)) {
    throw new Error('服务地址必须是有效的 http 或 https 地址')
  }

  // 规范化：去掉末尾斜杠，避免拼接出双斜杠
  const normalized = trimmed.replace(/\/+$/, '')
  writeFileSync(path, JSON.stringify({ userOverrideUrl: normalized }, null, 2), { mode: 0o600 })
  cachedUserOverride = normalized
  userOverrideLoaded = true
}

/** 解析当前生效的订阅服务地址。无法解析时返回 undefined。 */
export function resolveSubscriptionServiceUrl(): string | undefined {
  const userOverride = loadUserOverride()
  if (isUsableUrl(userOverride)) return userOverride

  if (isUsableUrl(process.env.GRAVITAS_SUBSCRIPTION_SERVICE_URL)) {
    return process.env.GRAVITAS_SUBSCRIPTION_SERVICE_URL
  }

  // 构建期注入的默认值。开发环境指向本机服务，生产构建时由构建脚本写入正式域名。
  const buildDefault = process.env.GRAVITAS_SUBSCRIPTION_DEFAULT_URL
  if (isUsableUrl(buildDefault)) return buildDefault

  return undefined
}

/** 供测试重置缓存 */
export function resetSubscriptionUrlCache(): void {
  cachedUserOverride = undefined
  userOverrideLoaded = false
}
