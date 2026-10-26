import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OwnerPreflightReconciliationPreview } from '@gravitas/shared'
import { ProjectOwnerPreflightReconciliationConfirm } from './ProjectOwnerPreflightReconciliationConfirm'

const preview: OwnerPreflightReconciliationPreview = {
  projectId: 'project-a',
  commandId: 'command-a',
  grantId: 'grant-a',
  executionId: 'execution-a',
  channelId: 'channel-a',
  modelId: 'glm-5.3-flash',
  provider: 'zhipu',
  evidenceKind: 'legacy_operator_attested',
  reasonCode: 'legacy_zhipu_protocol_mapping_before_fetch',
  errorMessage: 'Owner 命令输出上限与运行授权/审核价格证据不匹配',
  errorSha256: 'a'.repeat(64),
  reservedCostMicros: 500_000,
  requestReservationCount: 0,
  preReconciliationUsageMarker: 'runtime_unknown',
  preReconciliationUsageEvidenceSha256: 'c'.repeat(64),
  preReconciliationUsageRecordKeySha256: 'd'.repeat(64),
  runReservationsReleased: 1,
  grantWillPause: true,
  providerConsoleAttestationRequired: true,
  fingerprint: 'b'.repeat(64),
}
function render(checked: boolean, busy = false): string {
  return renderToStaticMarkup(createElement(ProjectOwnerPreflightReconciliationConfirm, {
    preview,
    busy,
    checked,
    onCheckedChange: () => {},
    onConfirm: () => {},
  }))
}

test('Given发送前失败对账预览 When未核对Provider控制台 Then显示本地证据边界且确认按钮禁用', () => {
  const html = render(false)
  expect(html).toContain('本地失败记录与操作人声明')
  expect(html).toContain('不是 Provider 签名账单')
  expect(html).toContain('历史兼容记录')
  expect(html).toContain('Runtime终态unknown标记')
  expect(html).toContain('我已核对对应渠道/模型的 Provider 控制台')
  expect(html).toContain('不会自动重试或恢复授权')
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>确认未发送并释放占额/)
})

test('Given已核对Provider控制台 When确认处理中 Then只显示确认态且按钮禁用', () => {
  const html = render(true, true)
  expect(html).toContain('正在记录对账…')
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>正在记录对账…/)
})
