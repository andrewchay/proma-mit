import { expect, test } from 'bun:test'
import { describeSampleScan, scanSampleForSensitiveContent } from './agent-employee-sample-scan'

test('检出路径、凭据、邮箱与长随机串', () => {
  const findings = scanSampleForSensitiveContent('失败原因：/Users/chaihao/secret/config.ts 中 apiKey=sk-abcdefghijklmnopqrst 无效，联系 dev@example.com，session_id=abc123')
  const kinds = findings.map((item) => item.kind)
  expect(kinds).toContain('absolute_path')
  expect(kinds).toContain('credential')
  expect(kinds).toContain('email')
  expect(kinds).toContain('session_reference')
})

test('同类问题只提示一次，避免刷屏', () => {
  const findings = scanSampleForSensitiveContent('/Users/a/file1.ts 与 /Users/b/file2.ts 都失败')
  expect(findings.filter((item) => item.kind === 'absolute_path')).toHaveLength(1)
})

test('干净摘要不提示，且提示语不省略信息', () => {
  const clean = '测试失败：缺少回归用例，建议先补测试再实现。'
  expect(scanSampleForSensitiveContent(clean)).toHaveLength(0)
  expect(describeSampleScan([])).toBeNull()

  const findings = scanSampleForSensitiveContent('路径 /Users/x/y 泄漏')
  const description = describeSampleScan(findings)
  expect(description).toContain('疑似敏感内容')
  expect(description).toContain('人工确认')
})
