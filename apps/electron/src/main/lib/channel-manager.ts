/**
 * 渠道管理器
 *
 * 负责渠道的 CRUD 操作、API Key 加密/解密、连接测试。
 * 使用 Electron safeStorage 进行 API Key 加密（底层使用 OS 级加密）。
 * 数据持久化到 ~/.proma/channels.json。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { getChannelsPath } from './config-paths'
import type {
  Channel,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChannelsConfig,
  ChannelTestResult,
  ChannelModel,
  FetchModelsInput,
  FetchModelsResult,
  ProviderType,
  ChannelPlanQuotaResult,
  ChannelPlanQuotaWindow,
} from '@gravitas/shared'
import { PROVIDER_DEFAULT_URLS, normalizeProviderType } from '@gravitas/shared'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { normalizeAnthropicBaseUrl, normalizeBaseUrl, normalizeVersionedAnthropicBaseUrl } from '@gravitas/core'

/** 当前配置版本 */
const CONFIG_VERSION = 1

/**
 * 读取渠道配置文件
 */
function readConfig(): ChannelsConfig {
  const configPath = getChannelsPath()

  if (!existsSync(configPath)) {
    return { version: CONFIG_VERSION, channels: [] }
  }

  try {
    const raw = readFileSync(configPath, 'utf-8')
    return JSON.parse(raw) as ChannelsConfig
  } catch (error) {
    console.error('[渠道管理] 读取配置文件失败:', error)
    return { version: CONFIG_VERSION, channels: [] }
  }
}

/**
 * 写入渠道配置文件
 */
function writeConfig(config: ChannelsConfig): void {
  const configPath = getChannelsPath()

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  } catch (error) {
    console.error('[渠道管理] 写入配置文件失败:', error)
    throw new Error('写入渠道配置失败')
  }
}

/**
 * 加密 API Key
 *
 * 使用 Electron safeStorage 加密，底层使用：
 * - macOS: Keychain
 * - Windows: DPAPI
 * - Linux: Secret Service API
 *
 * @returns base64 编码的加密字符串
 */
function encryptApiKey(plainKey: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[渠道管理] safeStorage 加密不可用，将以明文存储')
    return plainKey
  }

  const encrypted = safeStorage.encryptString(plainKey)
  return encrypted.toString('base64')
}

/**
 * 解密 API Key
 *
 * @param encryptedKey base64 编码的加密字符串
 * @returns 明文 API Key
 */
function decryptKey(encryptedKey: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    // 如果加密不可用，假设存储的是明文
    return encryptedKey
  }

  try {
    const buffer = Buffer.from(encryptedKey, 'base64')
    return safeStorage.decryptString(buffer)
  } catch (error) {
    console.error('[渠道管理] 解密 API Key 失败:', error)
    throw new Error('解密 API Key 失败')
  }
}

/**
 * 获取所有渠道
 *
 * 返回的渠道中 apiKey 保持加密状态。
 * 首次调用时，如果没有任何 DeepSeek 渠道，自动创建预设渠道。
 */
export function listChannels(): Channel[] {
  const config = readConfig()

  // 首次使用：如果没有 DeepSeek 渠道，自动创建预设
  const hasDeepSeek = config.channels.some(
    (c) => c.provider === 'deepseek' || c.provider === 'deepseek-openai' || c.baseUrl.includes('api.deepseek.com'),
  )
  if (!hasDeepSeek) {
    const now = Date.now()
    const presetChannel: Channel = {
      id: randomUUID(),
      name: 'DeepSeek',
      provider: 'deepseek',
      baseUrl: PROVIDER_DEFAULT_URLS.deepseek,
      apiKey: encryptApiKey(''),
      models: [
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true },
      ],
      enabled: false,
      createdAt: now,
      updatedAt: now,
    }
    config.channels.push(presetChannel)
    writeConfig(config)
    console.log('[渠道管理] 已自动创建 DeepSeek 预设渠道')
    return config.channels
  }

  // 归一化历史/旧版 provider 值（anthropic-compatible / proma → custom），避免渲染层崩溃
  return config.channels.map((c) => {
    const normalized = normalizeProviderType(c.provider as string | undefined | null)
    return normalized === c.provider ? c : { ...c, provider: normalized as ProviderType }
  })
}

/**
 * 按 ID 获取渠道
 *
 * 返回的渠道中 apiKey 保持加密状态。
 */
export function getChannelById(id: string): Channel | undefined {
  const config = readConfig()
  const channel = config.channels.find((c) => c.id === id)
  if (!channel) return undefined
  const normalized = normalizeProviderType(channel.provider as string | undefined | null)
  return normalized === channel.provider ? channel : { ...channel, provider: normalized as ProviderType }
}

/**
 * 创建新渠道
 *
 * @param input 渠道创建数据（apiKey 为明文，会自动加密）
 * @returns 创建后的渠道（apiKey 为加密态）
 */
export function createChannel(input: ChannelCreateInput): Channel {
  const config = readConfig()
  const now = Date.now()

  const channel: Channel = {
    id: randomUUID(),
    name: input.name,
    provider: input.provider,
    baseUrl: input.baseUrl,
    apiKey: encryptApiKey(input.apiKey),
    models: input.models,
    enabled: input.enabled,
    createdAt: now,
    updatedAt: now,
  }

  config.channels.push(channel)
  writeConfig(config)

  console.log(`[渠道管理] 已创建渠道: ${channel.name} (${channel.id})`)
  return channel
}

/**
 * 更新渠道
 *
 * @param id 渠道 ID
 * @param input 更新数据（apiKey 为明文，空字符串表示不更新）
 * @returns 更新后的渠道
 */
export function updateChannel(id: string, input: ChannelUpdateInput): Channel {
  const config = readConfig()
  const index = config.channels.findIndex((c) => c.id === id)

  if (index === -1) {
    throw new Error(`渠道不存在: ${id}`)
  }

  const existing = config.channels[index]!

  const updated: Channel = {
    ...existing,
    name: input.name ?? existing.name,
    provider: input.provider ?? existing.provider,
    baseUrl: input.baseUrl ?? existing.baseUrl,
    apiKey: input.apiKey ? encryptApiKey(input.apiKey) : existing.apiKey,
    models: input.models ?? existing.models,
    enabled: input.enabled ?? existing.enabled,
    updatedAt: Date.now(),
  }

  config.channels[index] = updated
  writeConfig(config)

  console.log(`[渠道管理] 已更新渠道: ${updated.name} (${updated.id})`)
  return updated
}

/**
 * 删除渠道
 */
export function deleteChannel(id: string): void {
  const config = readConfig()
  const index = config.channels.findIndex((c) => c.id === id)

  if (index === -1) {
    throw new Error(`渠道不存在: ${id}`)
  }

  const removed = config.channels.splice(index, 1)[0]!
  writeConfig(config)

  console.log(`[渠道管理] 已删除渠道: ${removed.name} (${removed.id})`)
}

/**
 * 解密渠道的 API Key
 *
 * 仅在用户需要查看时调用。
 */
export function decryptApiKey(channelId: string): string {
  const config = readConfig()
  const channel = config.channels.find((c) => c.id === channelId)

  if (!channel) {
    throw new Error(`渠道不存在: ${channelId}`)
  }

  return decryptKey(channel.apiKey)
}

/**
 * 测试渠道连接
 *
 * 向供应商的 API 发送简单请求，验证 API Key 和连接是否有效。
 */
export async function testChannel(channelId: string): Promise<ChannelTestResult> {
  const config = readConfig()
  const channel = config.channels.find((c) => c.id === channelId)

  if (!channel) {
    return { success: false, message: '渠道不存在' }
  }

  const apiKey = decryptKey(channel.apiKey)
  const proxyUrl = await getEffectiveProxyUrl()

  try {
    switch (channel.provider) {
      case 'anthropic':
      case 'deepseek':
      case 'kimi-api':
      case 'kimi-coding':
      case 'minimax':
        return await testAnthropicCompatible(channel.baseUrl, apiKey, proxyUrl, channel.provider)
      case 'openai':
      case 'deepseek-openai':
      case 'zhipu':
      case 'doubao':
      case 'qwen':
      case 'custom':
        return await testOpenAICompatible(channel.baseUrl, apiKey, proxyUrl)
      case 'google':
        return await testGoogle(channel.baseUrl, apiKey, proxyUrl)
      default:
        return { success: false, message: `不支持的供应商: ${channel.provider}。你可能过去使用的是 Proma 商业版，请重新下载商业版覆盖安装，当前版本为开源版本。` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    return { success: false, message: `连接测试失败: ${message}` }
  }
}

/**
 * 测试 Anthropic 兼容 API 连接（Anthropic / DeepSeek / Kimi API / Kimi Coding Plan / MiniMax）
 *
 * DeepSeek / Kimi 的 Anthropic API 端点无需 /v1 前缀。
 * Kimi Coding Plan 必须发送 User-Agent: KimiCLI/*，否则返回 403。
 */
async function testAnthropicCompatible(
  baseUrl: string,
  apiKey: string,
  proxyUrl?: string,
  provider: ProviderType = 'anthropic',
): Promise<ChannelTestResult> {
  const isNonVersionedPath =
    provider === 'deepseek' || provider === 'kimi-api' || provider === 'kimi-coding'
  const url = provider === 'minimax'
    ? normalizeVersionedAnthropicBaseUrl(baseUrl)
    : isNonVersionedPath ? normalizeBaseUrl(baseUrl) : normalizeAnthropicBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  let testModel: string
  switch (provider) {
    case 'deepseek':
      testModel = 'deepseek-v4-pro'
      break
    case 'kimi-api':
      testModel = 'kimi-k2.6'
      break
    case 'kimi-coding':
      testModel = 'kimi-for-coding'
      break
    case 'minimax':
      testModel = 'MiniMax-M2.7'
      break
    default:
      testModel = 'claude-sonnet-4-6'
  }

  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }
  if (provider === 'kimi-coding') {
    headers.Authorization = `Bearer ${apiKey}`
    headers['User-Agent'] = 'KimiCLI/1.3'
  } else if (provider === 'minimax') {
    headers.Authorization = `Bearer ${apiKey}`
  } else {
    headers['x-api-key'] = apiKey
    headers.Authorization = `Bearer ${apiKey}`
  }

  const response = await fetchFn(`${url}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: testModel,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })

  if (response.ok) {
    return { success: true, message: '连接成功' }
  }

  if (response.status === 401) {
    const text = await response.text().catch(() => '')
    return { success: false, message: `API Key 无效${text ? `: ${text.slice(0, 150)}` : ''}` }
  }

  // 如果能收到 API 的响应（即使是错误），说明连接是通的
  return { success: true, message: '连接成功' }
}

/**
 * 测试 OpenAI 兼容 API 连接（OpenAI / Custom）
 */
async function testOpenAICompatible(baseUrl: string, apiKey: string, proxyUrl?: string): Promise<ChannelTestResult> {
  const url = normalizeBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(`${url}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })

  if (response.ok) {
    return { success: true, message: '连接成功' }
  }

  if (response.status === 401) {
    return { success: false, message: 'API Key 无效' }
  }

  const text = await response.text().catch(() => '')
  return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}` }
}

/**
 * 测试 Google Generative AI API 连接
 */
async function testGoogle(baseUrl: string, apiKey: string, proxyUrl?: string): Promise<ChannelTestResult> {
  const url = normalizeBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(`${url}/v1beta/models?key=${apiKey}`, {
    method: 'GET',
  })

  if (response.ok) {
    return { success: true, message: '连接成功' }
  }

  if (response.status === 400 || response.status === 403) {
    return { success: false, message: 'API Key 无效' }
  }

  const text = await response.text().catch(() => '')
  return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}` }
}

// ===== 直接测试连接 =====

/**
 * 直接测试连接（无需已保存渠道）
 *
 * 使用传入的明文凭证直接向提供商发送测试请求。
 * 适用于创建/编辑渠道时用户在保存前先验证连接。
 */
export async function testChannelDirect(input: FetchModelsInput): Promise<ChannelTestResult> {
  const proxyUrl = await getEffectiveProxyUrl()

  try {
    switch (input.provider) {
      case 'anthropic':
      case 'deepseek':
      case 'kimi-api':
      case 'kimi-coding':
      case 'minimax':
        return await testAnthropicCompatible(input.baseUrl, input.apiKey, proxyUrl, input.provider)
      case 'openai':
      case 'deepseek-openai':
      case 'zhipu':
      case 'doubao':
      case 'qwen':
      case 'custom':
        return await testOpenAICompatible(input.baseUrl, input.apiKey, proxyUrl)
      case 'google':
        return await testGoogle(input.baseUrl, input.apiKey, proxyUrl)
      default:
        return { success: false, message: `不支持的提供商: ${input.provider}` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    return { success: false, message: `连接测试失败: ${message}` }
  }
}

// ===== 模型拉取相关 =====

/**
 * 从供应商 API 拉取可用模型列表
 *
 * 直接使用传入的凭证（无需已保存渠道），支持创建渠道时预先拉取模型。
 * 针对不同供应商使用不同的 API 端点和响应解析。
 */
export async function fetchModels(input: FetchModelsInput): Promise<FetchModelsResult> {
  const proxyUrl = await getEffectiveProxyUrl()

  try {
    switch (input.provider) {
      case 'anthropic':
      case 'deepseek':
      case 'kimi-api':
      case 'kimi-coding':
      case 'minimax':
        return await fetchAnthropicCompatibleModels(input.baseUrl, input.apiKey, proxyUrl, input.provider)
      case 'openai':
      case 'deepseek-openai':
      case 'zhipu':
      case 'doubao':
      case 'qwen':
      case 'custom':
        return await fetchOpenAICompatibleModels(input.baseUrl, input.apiKey, proxyUrl)
      case 'google':
        return await fetchGoogleModels(input.baseUrl, input.apiKey, proxyUrl)
      default:
        return { success: false, message: `不支持的供应商: ${input.provider}`, models: [] }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    console.error('[渠道管理] 拉取模型列表失败:', error)
    return { success: false, message: `拉取模型失败: ${message}`, models: [] }
  }
}

/**
 * Anthropic API 模型响应项
 */
interface AnthropicModelItem {
  id: string
  display_name?: string
  type?: string
}

/**
 * 从 Anthropic 兼容 API 拉取模型列表（Anthropic / DeepSeek / Kimi API / Kimi Coding Plan / MiniMax）
 *
 * DeepSeek / Kimi 的 Anthropic API 端点无需 /v1 前缀。
 * Kimi Coding Plan 必须发送 User-Agent: KimiCLI/*。
 * 文档: https://docs.anthropic.com/en/api/models-list
 */
async function fetchAnthropicCompatibleModels(
  baseUrl: string,
  apiKey: string,
  proxyUrl?: string,
  provider: ProviderType = 'anthropic',
): Promise<FetchModelsResult> {
  const isNonVersionedPath =
    provider === 'deepseek' || provider === 'kimi-api' || provider === 'kimi-coding'
  const url = provider === 'minimax'
    ? normalizeVersionedAnthropicBaseUrl(baseUrl)
    : isNonVersionedPath ? normalizeBaseUrl(baseUrl) : normalizeAnthropicBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  }
  if (provider === 'kimi-coding') {
    headers.Authorization = `Bearer ${apiKey}`
    headers['User-Agent'] = 'KimiCLI/1.3'
  } else if (provider === 'minimax') {
    headers.Authorization = `Bearer ${apiKey}`
  } else {
    headers['x-api-key'] = apiKey
    headers.Authorization = `Bearer ${apiKey}`
  }

  const response = await fetchFn(`${url}/models`, {
    method: 'GET',
    headers,
  })

  if (response.status === 401) {
    const text = await response.text().catch(() => '')
    return { success: false, message: `API Key 无效${text ? `: ${text.slice(0, 150)}` : ''}`, models: [] }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}`, models: [] }
  }

  const data = await response.json() as { data?: AnthropicModelItem[] }
  const items = data.data ?? []

  const models: ChannelModel[] = items.map((item) => ({
    id: item.id,
    name: item.display_name || item.id,
    enabled: true,
  }))

  return {
    success: true,
    message: `成功获取 ${models.length} 个模型`,
    models,
  }
}

/**
 * OpenAI 兼容 API 模型响应项
 */
interface OpenAIModelItem {
  id: string
  owned_by?: string
}

/**
 * 从 OpenAI 兼容 API 拉取模型列表（OpenAI / Custom）
 *
 * API: GET {baseUrl}/models
 * 通用 OpenAI 兼容格式，适用于大部分第三方供应商。
 */
async function fetchOpenAICompatibleModels(baseUrl: string, apiKey: string, proxyUrl?: string): Promise<FetchModelsResult> {
  const url = normalizeBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(`${url}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })

  if (response.status === 401) {
    return { success: false, message: 'API Key 无效', models: [] }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}`, models: [] }
  }

  const data = await response.json() as { data?: OpenAIModelItem[] }
  const items = data.data ?? []

  const models: ChannelModel[] = items.map((item) => ({
    id: item.id,
    name: item.id,
    enabled: true,
  }))

  // 按模型 ID 字母排序，方便用户查找
  models.sort((a, b) => a.id.localeCompare(b.id))

  return {
    success: true,
    message: `成功获取 ${models.length} 个模型`,
    models,
  }
}

/**
 * Google Generative AI 模型响应项
 */
interface GoogleModelItem {
  name: string
  displayName?: string
  description?: string
  supportedGenerationMethods?: string[]
}

/**
 * 从 Google Generative AI API 拉取模型列表
 *
 * API: GET /v1beta/models?key={apiKey}
 * 仅返回支持 generateContent 的模型（排除纯 embedding 模型）。
 */
async function fetchGoogleModels(baseUrl: string, apiKey: string, proxyUrl?: string): Promise<FetchModelsResult> {
  const url = normalizeBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(`${url}/v1beta/models?key=${apiKey}`, {
    method: 'GET',
  })

  if (response.status === 400 || response.status === 403) {
    return { success: false, message: 'API Key 无效', models: [] }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}`, models: [] }
  }

  const data = await response.json() as { models?: GoogleModelItem[] }
  const items = data.models ?? []

  // 过滤出支持 generateContent 的模型（排除纯 embedding 模型）
  const chatModels = items.filter((item) =>
    item.supportedGenerationMethods?.includes('generateContent')
  )

  const models: ChannelModel[] = chatModels.map((item) => {
    // Google 模型 name 格式为 "models/gemini-pro"，提取实际 ID
    const id = item.name.replace(/^models\//, '')
    return {
      id,
      name: item.displayName || id,
      enabled: true,
    }
  })

  return {
    success: true,
    message: `成功获取 ${models.length} 个模型`,
    models,
  }
}

// ===== 渠道订阅 Plan 额度查询 =====

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function normalizePlanQuotaTimestamp(value?: number | string): number | undefined {
  if (value == null || value === '') return undefined
  const timestamp = typeof value === 'number' ? value : new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return undefined
  return timestamp > 0 && timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp
}

function planQuotaResetAt(value?: number | string): Pick<ChannelPlanQuotaWindow, 'resetAt'> {
  const resetAt = normalizePlanQuotaTimestamp(value)
  return resetAt ? { resetAt } : {}
}

function createUnsupportedPlanQuota(provider: ProviderType, message: string): ChannelPlanQuotaResult {
  return {
    supported: false,
    provider,
    windows: [],
    updatedAt: Date.now(),
    message,
  }
}

function formatDeepSeekBalanceAmount(currency: string | undefined, value: string | number | undefined): string {
  const amount = Number(value ?? 0)
  if (!Number.isFinite(amount)) return '0.00'
  const normalizedCurrency = (currency ?? '').trim().toUpperCase()
  if (normalizedCurrency === 'CNY' || normalizedCurrency === 'RMB') return `¥${amount.toFixed(2)}`
  if (normalizedCurrency === 'USD') return `$${amount.toFixed(2)}`
  if (normalizedCurrency) return `${normalizedCurrency} ${amount.toFixed(2)}`
  return amount.toFixed(2)
}

/** 查询 DeepSeek 账户余额（CNY 优先）。 */
async function queryDeepSeekPlanQuota(
  apiKey: string,
  baseUrl: string,
  provider: ProviderType,
  proxyUrl?: string,
): Promise<ChannelPlanQuotaResult> {
  const fetchFn = getFetchFn(proxyUrl)
  let requestUrl = 'https://api.deepseek.com/user/balance'
  try {
    requestUrl = `${new URL(baseUrl).origin}/user/balance`
  } catch {
    // 保持官方默认查询地址
  }

  const response = await fetchFn(requestUrl, withQuotaTimeout({
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  }))
  const responseText = await response.text()
  if (!response.ok) {
    return createUnsupportedPlanQuota(provider, `DeepSeek 余额查询失败: HTTP ${response.status}`)
  }

  let data: {
    is_available?: boolean
    balance_infos?: Array<{
      currency?: string
      total_balance?: string
      granted_balance?: string
      topped_up_balance?: string
    }>
    error?: { message?: string }
  }
  try {
    data = JSON.parse(responseText)
  } catch {
    return createUnsupportedPlanQuota(provider, 'DeepSeek 余额响应格式错误')
  }

  if (data.error?.message) return createUnsupportedPlanQuota(provider, data.error.message)

  const balances = data.balance_infos ?? []
  if (balances.length === 0) return createUnsupportedPlanQuota(provider, 'DeepSeek 未返回余额数据')

  const preferred = balances.find((item) => (item.currency ?? '').toUpperCase() === 'CNY')
    ?? balances.find((item) => Number(item.total_balance ?? 0) > 0)
    ?? balances[0]!
  const amountLabel = formatDeepSeekBalanceAmount(preferred.currency, preferred.total_balance)
  const granted = Number(preferred.granted_balance ?? 0)
  const toppedUp = Number(preferred.topped_up_balance ?? 0)
  const total = Number(preferred.total_balance ?? 0)
  const denominator = granted + toppedUp
  const remainingPercent = denominator > 0
    ? clampPercent((total / denominator) * 100)
    : data.is_available === false
      ? 0
      : 100

  return {
    supported: true,
    provider,
    planName: 'DeepSeek 账户余额',
    windows: [{
      type: 'custom',
      label: '账户余额',
      remainingPercent,
      usedPercent: clampPercent(100 - remainingPercent),
      remainingLabel: amountLabel,
      showProgress: denominator > 0,
    }],
    updatedAt: Date.now(),
    message: data.is_available === false ? 'DeepSeek 账户余额不可用' : undefined,
  }
}

/** 查询 Kimi For Coding 订阅额度（每 5 小时 / 每周窗口）。 */
async function queryKimiPlanQuota(apiKey: string, proxyUrl?: string): Promise<ChannelPlanQuotaResult> {
  const fetchFn = getFetchFn(proxyUrl)
  const response = await fetchFn('https://api.kimi.com/coding/v1/usages', withQuotaTimeout({
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  }))
  const responseText = await response.text()
  if (!response.ok) {
    return createUnsupportedPlanQuota('kimi-coding', `Kimi 额度查询失败: HTTP ${response.status}`)
  }

  let data: {
    usage?: { remaining?: string | number; used?: string | number; resetTime?: string }
    limits?: Array<{
      window: { duration: number; timeUnit: string }
      detail: { remaining?: string | number; used?: string | number; resetTime?: string }
    }>
    code?: string
  }
  try {
    data = JSON.parse(responseText)
  } catch {
    return createUnsupportedPlanQuota('kimi-coding', 'Kimi 额度响应格式错误')
  }

  if (data.code) return createUnsupportedPlanQuota('kimi-coding', `Kimi 额度查询失败: ${data.code}`)
  if (!data.usage) return createUnsupportedPlanQuota('kimi-coding', 'Kimi 未返回订阅额度数据')

  const windows: ChannelPlanQuotaWindow[] = []
  const summaryRemaining = clampPercent(Number(data.usage.remaining ?? 0))
  const summaryUsed = clampPercent(Number(data.usage.used ?? (100 - summaryRemaining)))
  windows.push({
    type: 'weekly',
    label: '每周额度',
    remainingPercent: summaryRemaining,
    usedPercent: summaryUsed,
    ...planQuotaResetAt(data.usage.resetTime),
  })

  for (const item of data.limits ?? []) {
    const remaining = clampPercent(Number(item.detail.remaining ?? 0))
    const used = clampPercent(Number(item.detail.used ?? (100 - remaining)))
    const duration = item.window.duration
    const isFiveHourWindow = (duration === 5 && item.window.timeUnit === 'TIME_UNIT_HOUR')
      || (duration === 300 && item.window.timeUnit === 'TIME_UNIT_MINUTE')
    const unitLabel = item.window.timeUnit === 'TIME_UNIT_HOUR'
      ? '小时'
      : item.window.timeUnit === 'TIME_UNIT_MINUTE'
        ? '分钟'
        : item.window.timeUnit === 'TIME_UNIT_DAY'
          ? '天'
          : item.window.timeUnit === 'TIME_UNIT_MONTH'
            ? '月'
            : item.window.timeUnit
    windows.push({
      type: isFiveHourWindow ? '5h' : 'custom',
      label: isFiveHourWindow ? '每 5 小时' : `${duration} ${unitLabel}`,
      remainingPercent: remaining,
      usedPercent: used,
      ...planQuotaResetAt(item.detail.resetTime),
    })
  }

  return {
    supported: true,
    provider: 'kimi-coding',
    planName: 'Kimi For Coding',
    windows,
    updatedAt: Date.now(),
  }
}

/** 余额/额度查询超时（10s） */
function withQuotaTimeout(init: RequestInit, timeoutMs = 10000): RequestInit {
  return { ...init, signal: AbortSignal.timeout(timeoutMs) }
}

/**
 * 判断 Base URL 是否指向 DeepSeek 官方域名。
 * 用于自定义 OpenAI 兼容渠道也能识别为 DeepSeek 并查询余额。
 */
function isDeepSeekBaseUrl(baseUrl: string): boolean {
  return /api\.deepseek\.com/i.test(baseUrl)
}

/**
 * 查询渠道订阅 Plan 额度（DeepSeek 余额 / Kimi For Coding 窗口）。
 * 仅支持本地已知端点；失败返回 supported:false 供 UI 隐藏。
 */
export async function getChannelPlanQuota(channelId: string): Promise<ChannelPlanQuotaResult> {
  const channel = getChannelById(channelId)
  if (!channel) return createUnsupportedPlanQuota('custom', '渠道不存在')

  const proxyUrl = await getEffectiveProxyUrl()
  let apiKey: string
  try {
    apiKey = decryptKey(channel.apiKey)
  } catch {
    return createUnsupportedPlanQuota(channel.provider, '无法读取渠道 API Key')
  }

  try {
    if (channel.provider === 'deepseek' || channel.provider === 'deepseek-openai' || (channel.provider === 'custom' && isDeepSeekBaseUrl(channel.baseUrl))) {
      // 自定义 OpenAI 兼容渠道使用 DeepSeek 域名时，余额结果按 DeepSeek 展示
      const providerLabel = channel.provider === 'custom' ? 'deepseek' : channel.provider
      return await queryDeepSeekPlanQuota(apiKey, channel.baseUrl, providerLabel, proxyUrl)
    }
    if (channel.provider === 'kimi-coding' || channel.baseUrl.includes('api.kimi.com/coding')) {
      return await queryKimiPlanQuota(apiKey, proxyUrl)
    }
    return createUnsupportedPlanQuota(channel.provider, '当前渠道不支持订阅 Plan 额度查询')
  } catch (error) {
    const message = error instanceof Error ? error.message : '订阅额度查询失败'
    return createUnsupportedPlanQuota(channel.provider, message)
  }
}
