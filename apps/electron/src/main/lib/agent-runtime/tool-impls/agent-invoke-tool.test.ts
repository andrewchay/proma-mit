import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'invoke-tool-test-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
const sent: string[] = []
mock.module('../../agent-invoke-service', () => ({
  sendAgentInvoke: (_from: string, to: string, task: string) => { sent.push(`${to}:${task}`); return {} },
  invokeToText: () => '模拟请求',
}))
const store = await import('../../project-sqlite-store')
const { executeInvokeAgentTool } = await import('./agent-invoke-tool')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

test('Given 普通会话 When 成员互调 Then 模拟服务接收请求', async () => {
  const result = await executeInvokeAgentTool({ toMemberId: 'agent-example', task: ' 检查 ' }, { cwd: directory, sessionId: 'ordinary-session' })
  expect(result.isError).toBeFalsy()
  expect(sent).toEqual(['agent-example:检查'])
})
