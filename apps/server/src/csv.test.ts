import { expect, test } from 'bun:test'
import { csvValue } from './csv'

test('Given 导出字段包含潜在表格公式 When 编码 CSV Then 将文本标记为文本', () => {
  for (const value of ['=1+1', '+cmd', '-cmd', '@cmd', ' \t=1+1', '\rhello', '\uFEFF=1+1']) expect(csvValue(value)).toBe(`"'${value}"`)
  expect(csvValue('普通 "文字",内容')).toBe('"普通 ""文字"",内容"')
  expect(csvValue(-12)).toBe('"-12"')
})

test('Given 审计包含公式文本 When 以 CSV 和 JSON 导出 Then CSV 加文本前缀且 JSON 保留原值', async () => {
  const { createAuditComplianceService } = await import('./audit-compliance')
  const audit = { list: async () => [{ tenantId: 'tenant', userId: 'user', action: '=cmd', resource: '项目', result: 'success' }] }
  const service = createAuditComplianceService(audit as unknown as import('./audit').PostgresAuditLog)
  const scope = { tenantId: 'tenant', userId: 'user' }
  const csv = await service.exportAuditLog(scope, { format: 'csv' })
  const json = await service.exportAuditLog(scope, { format: 'json' })
  expect(csv).toContain(`"'=cmd"`)
  expect(JSON.parse(json)[0].action).toBe('=cmd')
})
