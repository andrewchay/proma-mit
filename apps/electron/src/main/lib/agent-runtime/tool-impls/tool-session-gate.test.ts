import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeExploreContextTool } from './context-graph-tool'
import { executeProposeAssetTool } from './asset-proposal-tool'
import { executeCostAuditTool } from './cost-audit-tool'
import { executeTodoContextTool } from './todo-context-tool'
import { executeRecallMemoryTool, executeAddMemoryTool } from './memory-tool'
import { executeInvokeAgentTool } from './agent-invoke-tool'
import { executeAgentTool } from './agent-tool'
import { executeReadTool } from './read-tool'
import { executeWriteTool } from './write-tool'
import { executeEditTool } from './edit-tool'
import { executeBashToolOnPlatform } from './bash-tool'
import { executeGrepTool } from './grep-tool'
import { executeWebFetchTool } from './web-fetch-tool'
import { executeWebSearchTool } from './web-search-tool'

const directory = mkdtempSync(join(tmpdir(), 'owner-tool-no-db-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
test('Given 权威项目账本不可用 When 直接调用工具 Then 拒绝读取、写入、编辑和执行', async () => {
  const path = join(directory, 'test.txt')
  writeFileSync(path, 'original')
  const context = { cwd: directory, sessionId: 'no-project-database' }
  const previousFetch = globalThis.fetch
  let networkCalls = 0
  let subAgentCalls = 0
  globalThis.fetch = (async () => { networkCalls++; return new Response('unexpected') }) as unknown as typeof fetch
  const results = await Promise.all([
    executeExploreContextTool({ entityType: 'session', entityId: 'other' }, context),
    executeProposeAssetTool({ sessionId: 'other' }, context),
    executeCostAuditTool({}, context),
    executeTodoContextTool({ todoId: 'other' }, context),
    executeRecallMemoryTool({ query: '偏好' }, context),
    executeAddMemoryTool({ userMessage: '偏好' }, context),
    executeInvokeAgentTool({ toMemberId: 'agent-example', task: '检查' }, context),
    executeAgentTool({ agent_name: 'explorer', task: '检查' }, { ...context, runSubAgent: async () => { subAgentCalls++; return 'unexpected' } }),
    executeReadTool({ file_path: 'test.txt' }, context),
    executeWriteTool({ file_path: 'test.txt', content: 'changed' }, context),
    executeEditTool({ file_path: 'test.txt', old_string: 'original', new_string: 'changed' }, context),
    executeBashToolOnPlatform({ command: 'echo changed > test.txt' }, context, 'darwin'),
    executeGrepTool({ regex: 'original' }, context),
    executeWebFetchTool({ url: 'https://example.invalid' }, context),
    executeWebSearchTool({ query: 'private query' }, context),
  ])
  globalThis.fetch = previousFetch
  expect(networkCalls).toBe(0)
  expect(subAgentCalls).toBe(0)
  expect(results.every(result => result.isError && result.content.includes('数据库未初始化'))).toBe(true)
  expect(readFileSync(path, 'utf8')).toBe('original')
})
