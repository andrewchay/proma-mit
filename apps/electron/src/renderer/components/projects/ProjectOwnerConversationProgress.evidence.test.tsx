import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OwnerExecutionTerminalEvidence } from './OwnerExecutionTerminalEvidence'

// 这个测试验证组件的可渲染性；真正的门禁逻辑由下面的纯函数测试覆盖。
test('Given失败命令的证据 When渲染组件 Then包含终止原因与工作树', () => {
  const html = renderToStaticMarkup(<OwnerExecutionTerminalEvidence evidence={{
    schemaVersion: 1, executionId: 'e1', commandId: 'c1', role: 'executor', executionStatus: 'failed',
    provider: { subtype: 'error_during_execution', finishReason: 'other', requestId: 'r1', responseId: null },
    reason: 'provider_stop', detail: '失败说明',
    tools: { calls: 0, results: 0, lastToolName: null, lastResultStatus: null, incompleteBatch: false },
    cost: { state: 'settled', actualCostMicros: 1000, requestCount: 1 },
    development: { worktreePath: '/tmp/w', baseCommit: 'a'.repeat(40), changedFiles: ['a.ts'], untrackedFiles: [] },
    capturedAt: 1,
  }} />)
  expect(html).toContain('服务商提前结束响应')
  expect(html).toContain('a.ts')
})
