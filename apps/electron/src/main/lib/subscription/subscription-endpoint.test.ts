import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveSubscriptionServiceUrl,
  setUserSubscriptionUrl,
  resetSubscriptionUrlCache,
} from './subscription-endpoint'

describe('订阅服务地址解析', () => {
  let tempDir: string
  const originalEnv = { ...process.env }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'subscription-endpoint-test-'))
    process.env.PROMA_TEST_CONFIG_DIR = tempDir
    delete process.env.GRAVITAS_SUBSCRIPTION_SERVICE_URL
    delete process.env.GRAVITAS_SUBSCRIPTION_DEFAULT_URL
    resetSubscriptionUrlCache()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('未配置任何来源时返回 undefined，不静默回退到 localhost', () => {
    expect(resolveSubscriptionServiceUrl()).toBeUndefined()
  })

  test('读取构建期默认地址', () => {
    process.env.GRAVITAS_SUBSCRIPTION_DEFAULT_URL = 'https://default.example.com'
    resetSubscriptionUrlCache()
    expect(resolveSubscriptionServiceUrl()).toBe('https://default.example.com')
  })

  test('环境变量优先于构建期默认值', () => {
    process.env.GRAVITAS_SUBSCRIPTION_DEFAULT_URL = 'https://default.example.com'
    process.env.GRAVITAS_SUBSCRIPTION_SERVICE_URL = 'https://env.example.com'
    resetSubscriptionUrlCache()
    expect(resolveSubscriptionServiceUrl()).toBe('https://env.example.com')
  })

  test('用户自定义地址优先级最高', () => {
    process.env.GRAVITAS_SUBSCRIPTION_SERVICE_URL = 'https://env.example.com'
    resetSubscriptionUrlCache()
    setUserSubscriptionUrl('https://user.example.com')

    expect(resolveSubscriptionServiceUrl()).toBe('https://user.example.com')
  })

  test('保存时去掉末尾斜杠，避免拼接出双斜杠', () => {
    setUserSubscriptionUrl('https://user.example.com///')
    expect(resolveSubscriptionServiceUrl()).toBe('https://user.example.com')
  })

  test('传空字符串清除自定义地址并回退', () => {
    process.env.GRAVITAS_SUBSCRIPTION_DEFAULT_URL = 'https://default.example.com'
    resetSubscriptionUrlCache()
    setUserSubscriptionUrl('https://user.example.com')
    expect(resolveSubscriptionServiceUrl()).toBe('https://user.example.com')

    setUserSubscriptionUrl('')
    expect(resolveSubscriptionServiceUrl()).toBe('https://default.example.com')
  })

  test('拒绝非法地址', () => {
    expect(() => setUserSubscriptionUrl('not-a-url')).toThrow()
    expect(() => setUserSubscriptionUrl('ftp://example.com')).toThrow()
  })

  test('忽略环境变量中的非法地址', () => {
    process.env.GRAVITAS_SUBSCRIPTION_SERVICE_URL = 'garbage'
    resetSubscriptionUrlCache()
    expect(resolveSubscriptionServiceUrl()).toBeUndefined()
  })

  test('配置文件损坏时不影响解析，回退到环境变量', () => {
    const dir = join(tempDir, 'subscription')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'endpoint.json'), '{ 这不是合法 JSON')
    process.env.GRAVITAS_SUBSCRIPTION_DEFAULT_URL = 'https://default.example.com'
    resetSubscriptionUrlCache()

    expect(resolveSubscriptionServiceUrl()).toBe('https://default.example.com')
  })
})
