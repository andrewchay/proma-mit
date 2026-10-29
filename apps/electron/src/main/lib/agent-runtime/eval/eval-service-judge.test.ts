import { expect, mock, test } from 'bun:test'
import type { BenchmarkConfig } from './types'
import { buildElectronMock } from '../../testing/electron-mock'

mock.module('electron', () => buildElectronMock())
mock.module('./eval-runner', () => ({
  resolveJudgeChannel: (benchmark: BenchmarkConfig) => benchmark.judgeRuntime ? { channel: { channelId: 'judge', modelId: 'different', provider: 'openai', apiKey: '', baseUrl: '' }, independent: true } : null,
  resolveEvalChannel: () => { throw new Error('测试不发送请求') },
  buildEvalDelegate: () => { throw new Error('测试不发送请求') },
}))
const { resolveJudge } = await import('./eval-service')
const benchmark: BenchmarkConfig = { id: 'b', title: 'b', description: '', targetAgentId: 'a', runtime: { provider: 'openai', modelId: 'tested' }, runsPerCase: 1, targetScore: 80, cases: ['c'], createdAt: '', updatedAt: '', judgeRuntime: { provider: 'openai', channelId: 'judge', modelId: 'different' } }
const channel = { channelId: 'tested', modelId: 'tested', provider: 'openai' as const, apiKey: '', baseUrl: '' }

test('Given 注入的评分函数或规则评分 When 指定不同配置 Then 不伪称已验证独立性', () => {
  const injected = resolveJudge(benchmark, channel, { scoreDelegate: async () => 90 })
  expect(injected.judge).toEqual({ kind: 'injected', independent: false })
  const rules = resolveJudge({ ...benchmark, judgeRuntime: undefined }, channel, {})
  expect(rules.judge).toMatchObject({ kind: 'rule', independent: false })
})
