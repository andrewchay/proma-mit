/**
 * 工具入口身份门禁回归：未走 guardOwnerTool 包装的工具同样必须先比对绑定身份。
 *
 * 覆盖 Grep / Agent 委派 / 记忆 / 联网读取这些「只做用途门禁、曾漏掉身份校验」的入口；
 * 缺绑定一律拒绝，避免调用方用裸 sessionId 绕过 Runtime 绑定。
 */

import { describe, expect, test } from 'bun:test'
import { executeGrepTool } from './grep-tool'
import { executeAgentTool } from './agent-tool'
import { executeInvokeAgentTool } from './agent-invoke-tool'
import { executeRecallMemoryTool } from './memory-tool'
import { executeWebFetchTool } from './web-fetch-tool'
import { executeWebSearchTool } from './web-search-tool'
import { bindTestToolContext } from '../../testing/bound-tool-context'

const bare = { cwd: '/tmp/workspace', sessionId: 'unbound-session' }
const missingBinding = '缺少已绑定的会话身份'

describe('未绑定身份的工具入口', () => {
  test('Given 未绑定会话 When 调用 Grep 与 Agent 委派 Then 拒绝并提示缺绑定', async () => {
    const grep = await executeGrepTool({ regex: 'x' }, bare)
    expect(grep.isError).toBe(true)
    expect(grep.content).toContain(missingBinding)

    // Agent 工具先检查运行器与参数，再进门禁；这里给齐前置条件，确保验证到的是身份门禁。
    const agent = await executeAgentTool({ agent_name: 'reviewer', task: '调研' }, { ...bare, runSubAgent: async () => 'ok' })
    expect(agent.isError).toBe(true)
    expect(agent.content).toContain(missingBinding)

    const invoke = await executeInvokeAgentTool({ toMemberId: 'agent-x', task: '检查' }, bare)
    expect(invoke.isError).toBe(true)
    expect(invoke.content).toContain(missingBinding)
  })

  test('Given 未绑定会话 When 调用记忆与联网读取 Then 拒绝并提示缺绑定', async () => {
    const recall = await executeRecallMemoryTool({ query: '偏好' }, bare)
    expect(recall.isError).toBe(true)
    expect(recall.content).toContain(missingBinding)

    const fetchTool = await executeWebFetchTool({ url: 'https://example.invalid/' }, bare)
    expect(fetchTool.isError).toBe(true)
    expect(fetchTool.content).toContain(missingBinding)

    const search = await executeWebSearchTool({ query: '天气' }, bare)
    expect(search.isError).toBe(true)
    expect(search.content).toContain(missingBinding)
  })

  test('Given 已绑定会话 When 调用 Grep Then 不再因身份被拒', async () => {
    const bound = bindTestToolContext({ cwd: '/tmp/workspace', sessionId: 'bound-session' })
    const result = await executeGrepTool({ regex: 'definitely-not-present-token' }, bound)
    // 目录不存在或搜不到都算正常返回；关键是不能出现身份拒绝文案。
    expect(result.content).not.toContain(missingBinding)
  })
})
