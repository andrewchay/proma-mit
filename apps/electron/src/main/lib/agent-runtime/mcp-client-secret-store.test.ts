/**
 * MCP client_secret 加密存储单元测试
 */

process.env.PROMA_DEV = '1'

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getMcpClientSecret, setMcpClientSecret, removeMcpClientSecret } from './mcp-client-secret-store'

let originalHome: string
let tempDir: string

beforeEach(() => {
  originalHome = process.env.HOME ?? ''
  tempDir = mkdtempSync(join(tmpdir(), 'proma-mcp-secret-test-'))
  process.env.HOME = tempDir
})

afterEach(() => {
  process.env.HOME = originalHome
  rmSync(tempDir, { recursive: true, force: true })
})

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
})
