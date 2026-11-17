import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OwnerExecutionTerminalEvidence } from './OwnerExecutionTerminalEvidence'

const base = {
  schemaVersion: 1 as const, executionId: 'e1', commandId: 'c1', role: 'executor' as const,
  executionStatus: 'failed',
  provider: { subtype: 'error_during_execution', finishReason: 'other', requestId: 'req-1', responseId: null },
  reason: 'provider_stop' as const, detail: 'Owner模型未完整结束',
  tools: { calls: 3, results: 3, lastToolName: 'Edit', lastResultStatus: 'ok' as const, incompleteBatch: false },
  cost: { state: 'settled' as const, actualCostMicros: 12345, requestCount: 2 },
  development: { worktreePath: '/tmp/w', baseCommit: 'a'.repeat(40), changedFiles: ['index.html'], untrackedFiles: ['new.css'] },
  capturedAt: 1,
}

test('GivenProvider异常终态 When渲染 Then展示原始终止原因、工具完成情况与费用状态', () => {
  const html = renderToStaticMarkup(<OwnerExecutionTerminalEvidence evidence={base} />)
  expect(html).toContain('error_during_execution')
  expect(html).toContain('other')
  expect(html).toContain('已结算')
  expect(html).toContain('index.html')
  expect(html).toContain('new.css')
})

test('Given达到输出上限 When渲染 Then展示对应的原因文案', () => {
  const html = renderToStaticMarkup(<OwnerExecutionTerminalEvidence evidence={{ ...base, reason: 'output_limit' }} />)
  expect(html).toContain('达到模型输出上限')
})

test('Given正常完成 When渲染 Then展示已正常完成', () => {
  const html = renderToStaticMarkup(<OwnerExecutionTerminalEvidence evidence={{ ...base, reason: 'completed', executionStatus: 'completed' }} />)
  expect(html).toContain('已正常完成')
})

test('Given费用未知 When渲染 Then明确标注未知而不是显示0', () => {
  const html = renderToStaticMarkup(<OwnerExecutionTerminalEvidence evidence={{ ...base, cost: { state: 'unknown', actualCostMicros: null, requestCount: 1 } }} />)
  expect(html).toContain('未知')
  expect(html).not.toContain('0.0000 美元')
})

test('Given没有研发工作树 When渲染 Then不出现工作树区块', () => {
  const html = renderToStaticMarkup(<OwnerExecutionTerminalEvidence evidence={{ ...base, development: null }} />)
  expect(html).not.toContain('工作树')
})

test('Given工具批次不完整 When渲染 Then明确提示未完成调用', () => {
  const html = renderToStaticMarkup(<OwnerExecutionTerminalEvidence evidence={{ ...base, tools: { ...base.tools, incompleteBatch: true } }} />)
  expect(html).toContain('未完成调用')
})
