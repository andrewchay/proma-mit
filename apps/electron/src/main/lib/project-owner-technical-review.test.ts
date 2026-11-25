import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { assertOwnerDevelopmentValidationForVerdict, parseOwnerTechnicalReviewResponse, normalizeOwnerTechnicalReviewQuotes, normalizeOwnerTechnicalReviewReceipt } from './project-owner-technical-review'

const criteria = ['接口保持兼容', '回归测试通过']

test('Given评审引用仅有引号排版差异 When唯一匹配成果原文 Then恢复逐字引用并保留其他差异的拒绝', () => {
  const content = '原文是"示例"，且结果正确。'
  const receipt = JSON.stringify({ criteria: [{ quote: '原文是“示例”，且结果正确。' }] })
  expect(JSON.parse(normalizeOwnerTechnicalReviewQuotes(receipt, content)).criteria[0].quote).toBe(content)
  expect(normalizeOwnerTechnicalReviewQuotes(receipt, `${content}\n${content}`)).toBe(receipt)
  const fabricated = JSON.stringify({ criteria: [{ quote: '原文是“示例”，且结果错误。' }] })
  expect(normalizeOwnerTechnicalReviewQuotes(fabricated, content)).toBe(fabricated)
})

function response(verdict: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    verdict,
    summary: '按冻结标准完成独立技术评审。',
    criteria: [
      { criterion: criteria[0], status: 'met', evidence: '接口测试通过' },
      { criterion: criteria[1], status: verdict === 'approved' ? 'met' : 'not_met', evidence: '回归测试结果' },
    ],
    findings: verdict === 'changes_requested'
      ? [{ severity: 'medium', description: '缺少回归断言。', requestedChange: '补充覆盖失败输入的测试。' }]
      : [],
    blockerReason: null,
    ...overrides,
  })
}

test('Given严格匹配全部冻结标准的评审输出 When解析 Then产生技术通过建议而非业务验收', () => {
  expect(parseOwnerTechnicalReviewResponse(response('approved'), criteria)).toMatchObject({
    schemaVersion: 1,
    verdict: 'approved',
    criteria: criteria.map(criterion => ({ criterion, status: 'met' })),
  })
})

test('Given评审发现标准未满足 When解析 Then必须附带可执行 finding', () => {
  expect(parseOwnerTechnicalReviewResponse(response('changes_requested'), criteria)).toMatchObject({ verdict: 'changes_requested' })
  expect(() => parseOwnerTechnicalReviewResponse(response('changes_requested', { findings: [] }), criteria)).toThrow()
})

test('Given标准未逐项覆盖或存在未验证项 When输出approved Then拒绝通过建议', () => {
  expect(() => parseOwnerTechnicalReviewResponse(response('approved', { criteria: [] }), criteria)).toThrow()
  expect(() => parseOwnerTechnicalReviewResponse(response('approved', {
    criteria: [
      { criterion: criteria[0], status: 'met', evidence: 'ok' },
      { criterion: criteria[1], status: 'not_verified', evidence: '未运行' },
    ],
  }), criteria)).toThrow()
})

test('Given非法/多余字段、无效 verdict 或超长响应 When解析 Then fail-closed', () => {
  expect(() => parseOwnerTechnicalReviewResponse('{"schemaVersion":1,"verdict":"pass"}', criteria)).toThrow()
  expect(() => parseOwnerTechnicalReviewResponse(response('approved', { injected: true }), criteria)).toThrow()
  expect(() => parseOwnerTechnicalReviewResponse('x'.repeat(100_001), criteria)).toThrow()
})

test('Given所有冻结验证命令均有新鲜、未截断且成功的原始回执 When Reviewer 建议通过 Then允许形成技术评审证据', () => {
  expect(() => assertOwnerDevelopmentValidationForVerdict('approved', [{
    command: 'bun test', validationId: `val-${'a'.repeat(64)}`, attemptState: 'completed', freshness: 'fresh',
    status: 'passed', exitCode: 0, timedOut: false, outputTail: '通过', outputTruncated: false,
    rawOutputSha256: 'b'.repeat(64), rawOutputByteLength: 4,
  }])).not.toThrow()
})

test('Given代码验证回执缺失、失败、超期、截断或原始输出摘要不完整 When Reviewer 建议通过 Then拒绝批准', () => {
  const valid = {
    command: 'bun test', validationId: `val-${'a'.repeat(64)}`, attemptState: 'completed' as const, freshness: 'fresh' as const,
    status: 'passed' as const, exitCode: 0, timedOut: false, outputTail: '通过', outputTruncated: false,
    rawOutputSha256: 'b'.repeat(64), rawOutputByteLength: 4,
  }
  const invalid = [
    { ...valid, attemptState: 'missing' as const },
    { ...valid, freshness: 'stale' as const },
    { ...valid, status: 'failed' as const },
    { ...valid, exitCode: 1 },
    { ...valid, timedOut: true },
    { ...valid, outputTruncated: true },
    { ...valid, rawOutputSha256: undefined },
    // 超过有效期的证据即便字段齐全也不得支撑通过。
    { ...valid, expired: true },
  ]
  for (const evidence of invalid) expect(() => assertOwnerDevelopmentValidationForVerdict('approved', [evidence])).toThrow('不能批准')
  expect(() => assertOwnerDevelopmentValidationForVerdict('changes_requested', [{ ...valid, status: 'failed' }])).not.toThrow()
})

test('Given完整文本评审v2 When引用正文 Then每项met必须有准确原文，错误哈希/漏quote/虚构quote拒绝', () => {
  const hash = 'a'.repeat(64), content = '接口保持兼容，回归测试通过。'
  const value = JSON.parse(response('approved', { schemaVersion: 2, artifactHash: hash })) as { criteria: Array<{ criterion: string; status: string; evidence: string; quote?: string | null }> }
  value.criteria.forEach((item, index) => { item.quote = criteria[index]! })
  expect(parseOwnerTechnicalReviewResponse(JSON.stringify(value), criteria, hash, content)).toMatchObject({ schemaVersion: 2, artifactHash: hash })
  expect(() => parseOwnerTechnicalReviewResponse(JSON.stringify(value), criteria, 'b'.repeat(64), content)).toThrow('准确成果版本')
  value.criteria[0]!.quote = '正文没有这句话'
  expect(() => parseOwnerTechnicalReviewResponse(JSON.stringify(value), criteria, hash, content)).toThrow('原文依据')
  delete value.criteria[0]!.quote
  expect(() => parseOwnerTechnicalReviewResponse(JSON.stringify(value), criteria, hash, content)).toThrow()
  expect(() => parseOwnerTechnicalReviewResponse(response('approved'), criteria, hash, content)).toThrow()
  expect(() => parseOwnerTechnicalReviewResponse(JSON.stringify(value), criteria)).toThrow()
})


test('Given代码评审同时引用说明缺陷与完整浏览器回执 Then接受精确回执引用且拒绝篡改或截断', () => {
  const quote = '实际点击清空后输入为空且三项归零'
  const output = JSON.stringify([{ status: 'passed', detail: quote }])
  const validation = { command: 'browser:text-counter.behavior', validationId: `val-${'b'.repeat(64)}`,
    attemptState: 'completed', freshness: 'fresh', status: 'passed', exitCode: 0, timedOut: false, outputTruncated: false,
    outputTail: output, rawOutputSha256: createHash('sha256').update(output).digest('hex'), rawOutputByteLength: Buffer.byteLength(output) } as const
  const artifactHash = 'a'.repeat(64)
  const fileQuote = '示例错误：多写一次换行'
  const content = JSON.stringify({ files: [{ oldContent: null, newContent: fileQuote }] })
  const raw = response('changes_requested', { schemaVersion: 3, artifactHash, criteria: [
    { criterion: criteria[0], status: 'not_met', evidence: '文档与实现不符', quote: fileQuote },
    { criterion: criteria[1], status: 'met', evidence: '浏览器实测成功', quote },
  ] })
  const parse = (evidence = [validation]) => parseOwnerTechnicalReviewResponse(raw, criteria, artifactHash, content, 'development', evidence)
  expect(parse().verdict).toBe('changes_requested')
  expect(() => parse([])).toThrow('原文依据')
  expect(() => parse([{ ...validation, rawOutputSha256: 'f'.repeat(64) }])).toThrow('原文依据')
  expect(() => parseOwnerTechnicalReviewResponse(raw, criteria, artifactHash, content, 'development', [{ ...validation, outputTruncated: true }])).toThrow('原文依据')
})

test('Given代码评审明确有验证缺口 When证明材料不是逐字引用 Then保留阻断理由和真实引用', () => {
  const artifactHash = 'a'.repeat(64)
  const content = JSON.stringify({ files: [{ newContent: '<span id="count">0</span>' }] })
  const input = { schemaVersion: 3, artifactHash, blockerReason: '尚无交互验证', criteria: [
    { criterion: criteria[0], status: 'met', evidence: '初始值有源码依据', quote: '<span id="count">0</span>' },
    { criterion: criteria[1], status: 'not_verified', evidence: '只有页面加载证据', quote: '页面加载通过，未执行交互验证' },
  ] }
  const parse = (raw: string) => parseOwnerTechnicalReviewResponse(normalizeOwnerTechnicalReviewReceipt(raw, content), criteria, artifactHash, content, 'development')
  expect(parse(response('blocked', input))).toMatchObject({
    verdict: 'blocked', blockerReason: input.blockerReason,
    criteria: [input.criteria[0], { ...input.criteria[1], quote: null }],
  })
  expect(() => parse(response('approved', { ...input, blockerReason: null }))).toThrow()
  input.criteria[1]!.status = 'met'
  expect(() => parse(response('blocked', input))).toThrow('原文依据')
})
