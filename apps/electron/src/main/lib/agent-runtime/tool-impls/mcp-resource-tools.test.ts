import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '../types'
import { createListMcpResourcesToolDefinition, createReadMcpResourceToolDefinition } from './mcp-resource-tools'

const directory = mkdtempSync(join(tmpdir(), 'mcp-resource-gate-')), previous = process.env.PROMA_TEST_CONFIG_DIR
const store = await import('../../project-sqlite-store')
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = directory; await store.initProjectDb() })
afterAll(() => { store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })

test('Given 普通会话 When 读取 MCP 资源 Then 返回模拟服务结果', async () => {
  const mcpManager = { listAllResources: async () => [{ name: '资源' }], readResource: async () => ({ text: '内容' }) } as unknown as ToolContext['mcpManager']
  const ctx = { cwd: directory, sessionId: 'ordinary', mcpManager }
  expect((await createListMcpResourcesToolDefinition().execute({}, ctx)).content).toContain('资源')
  expect((await createReadMcpResourceToolDefinition().execute({ uri: 'example:test' }, ctx)).content).toContain('内容')
})

test('Given MCP 响应等待期间账本失效 When 返回 Then 不泄露结果', async () => {
  let finish!: (value: Array<{ name: string }>) => void
  const mcpManager = { listAllResources: () => new Promise<Array<{ name: string }>>(resolve => { finish = resolve }) } as unknown as ToolContext['mcpManager']
  const pending = createListMcpResourcesToolDefinition().execute({}, { cwd: directory, sessionId: 'ordinary', mcpManager })
  store.closeProjectDb()
  finish([{ name: '私有结果' }])
  const result = await pending
  expect(result.isError).toBe(true)
  expect(result.content).not.toContain('私有结果')
})
