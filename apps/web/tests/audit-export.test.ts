import { expect, test } from 'bun:test'
import { exportAuditCsv } from '../src/download'

test('Given 审计员导出筛选结果 When 已认证请求成功 Then 下载 CSV', async () => {
  const paths: string[] = [], saved: Array<{ name: string; blob: Blob }> = []
  await exportAuditCsv(async path => { paths.push(path); return new Response('action\nread') }, 'read & write', (blob, name) => { saved.push({ name, blob }) })
  expect(paths).toEqual(['/agent/audit/export?format=csv&action=read+%26+write'])
  expect(saved[0]?.name).toBe('audit.csv')
  expect(await saved[0]!.blob.text()).toBe('action\nread')
})

test('Given 导出被拒绝 When 服务器返回 403 Then 不下载', async () => {
  let saved = false
  await expect(exportAuditCsv(async () => new Response('forbidden', { status: 403 }), '', () => { saved = true })).rejects.toThrow('403')
  expect(saved).toBe(false)
})
