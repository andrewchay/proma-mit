/**
 * MCP client_secret 加密存储单元测试
 */

process.env.PROMA_DEV = '1'

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getMcpClientSecret, setMcpClientSecret, removeMcpClientSecret } from './mcp-client-secret-store'
import { setRuntimeSecretCodecForTesting, type RuntimeSecretCodec } from './runtime-secret-codec'

let originalHome: string
let originalTestConfigDir: string | undefined
let tempDir: string

beforeEach(() => {
  originalHome = process.env.HOME ?? ''
  originalTestConfigDir = process.env.PROMA_TEST_CONFIG_DIR
  tempDir = mkdtempSync(join(tmpdir(), 'proma-mcp-secret-test-'))
  process.env.HOME = tempDir
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
  setRuntimeSecretCodecForTesting()
})

afterEach(() => {
  setRuntimeSecretCodecForTesting()
  process.env.HOME = originalHome
  if (originalTestConfigDir === undefined) {
    delete process.env.PROMA_TEST_CONFIG_DIR
  } else {
    process.env.PROMA_TEST_CONFIG_DIR = originalTestConfigDir
  }
  rmSync(tempDir, { recursive: true, force: true })
})

class PrefixRuntimeSecretCodec implements RuntimeSecretCodec {
  encode(plain: string, scope: string): string {
    return Buffer.from(`${scope}:${plain}`).toString('base64')
  }

  decode(encoded: string, scope: string): string {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
    const prefix = `${scope}:`
    if (!decoded.startsWith(prefix)) {
      throw new Error(`scope mismatch: ${scope}`)
    }
    return decoded.slice(prefix.length)
  }
}

describe('MCP client_secret 存储', () => {
  test('保存并读取 client_secret', () => {
    setMcpClientSecret('ws1', 'github', 'super-secret')
    expect(getMcpClientSecret('ws1', 'github')).toBe('super-secret')
  })

  test('读取不存在的 secret 返回 undefined', () => {
    expect(getMcpClientSecret('ws1', 'none')).toBeUndefined()
  })

  test('删除指定服务器的 secret', () => {
    setMcpClientSecret('ws2', 'a', 'a-secret')
    setMcpClientSecret('ws2', 'b', 'b-secret')
    removeMcpClientSecret('ws2', 'a')
    expect(getMcpClientSecret('ws2', 'a')).toBeUndefined()
    expect(getMcpClientSecret('ws2', 'b')).toBe('b-secret')
  })

  test('更新同一服务器的 secret', () => {
    setMcpClientSecret('ws3', 'srv', 'old')
    setMcpClientSecret('ws3', 'srv', 'new')
    expect(getMcpClientSecret('ws3', 'srv')).toBe('new')
  })

  test('可注入 runtime secret codec，服务端 Web 可替换 Electron safeStorage', () => {
    setRuntimeSecretCodecForTesting(new PrefixRuntimeSecretCodec())
    setMcpClientSecret('ws-codec', 'srv', 'super-secret')

    const encodedStore = readFileSync(join(tempDir, 'mcp-client-secrets.json'), 'utf-8')
    const decodedStore = Buffer.from(encodedStore, 'base64').toString('utf-8')
    expect(decodedStore.startsWith('MCP client_secret:')).toBe(true)
    expect(encodedStore).not.toContain('super-secret')
    expect(getMcpClientSecret('ws-codec', 'srv')).toBe('super-secret')
  })
})
