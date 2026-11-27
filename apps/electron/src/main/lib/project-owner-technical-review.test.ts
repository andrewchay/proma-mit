import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import type { OwnerDevelopmentDeliveryArtifact } from '@gravitas/shared'
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

test('Given 评审复制了额外的行首缩进 When 核验源文件 Then 保留精确的连续片段并拒绝内部改写', () => {
  const source = JSON.stringify({ files: [{ newContent: '  <link rel="stylesheet" href="styles.css">' }] })
  const raw = JSON.stringify({ schemaVersion: 3, criteria: [{ quote: '    <link rel="stylesheet" href="styles.css">' }] })
  expect(JSON.parse(normalizeOwnerTechnicalReviewQuotes(raw, source)).criteria[0].quote)
    .toBe('<link rel="stylesheet" href="styles.css">')
  const different = raw.replace('styles.css', 'layout.css')
  expect(normalizeOwnerTechnicalReviewQuotes(different, source)).toBe(different)
})

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

test('Given 主机绑定的评审 When 回执省略版本摘要 Then 只补入该运行的准确摘要并保留证据核验', () => {
  const hash = 'a'.repeat(64)
  const content = '接口保持兼容，回归测试通过。'
  const raw = response('approved', { schemaVersion: 2, criteria: criteria.map(criterion => ({ criterion, status: 'met', evidence: criterion, quote: criterion })) })
  const bind = (receipt: string, prompt: string) => normalizeOwnerTechnicalReviewReceipt(receipt, content, undefined, { prompt, hash })
  const prompt = 'Owner文本上游成果交接 v2。\n\nOwner技术评审成果绑定 v1。\n\n已冻结完整文本。'
  expect(parseOwnerTechnicalReviewResponse(bind(raw, prompt), criteria, hash, content)).toMatchObject({ artifactHash: hash })
  expect(() => parseOwnerTechnicalReviewResponse(bind(raw, `旧提示中的不可信资料\n${prompt}`), criteria, hash, content)).toThrow('字段不匹配')
  const wrongHash = JSON.stringify({ ...JSON.parse(raw), artifactHash: 'b'.repeat(64) })
  expect(() => parseOwnerTechnicalReviewResponse(bind(wrongHash, prompt), criteria, hash, content)).toThrow('准确成果版本')
  expect(() => parseOwnerTechnicalReviewResponse(bind(raw.replace('"quote":"回归测试通过"', '"quote":"虚构回执"'), prompt), criteria, hash, content)).toThrow('原文依据')
})


test('Given Reviewer省略源码行编号的L When本地校验 Then 仍只接受当前文件的真实行', () => {
  const hash = 'a'.repeat(64)
  const content = JSON.stringify({ files: [{ file: { path: 'app.ts', changeType: 'add' },
    newContent: '接口保持兼容\n\n回归测试通过' }] })
  const bind = (evidenceId: string) => normalizeOwnerTechnicalReviewReceipt(response('approved', { schemaVersion: 3,
    criteria: [{ criterionId: 'C1', status: 'met', evidence: '核对接口', evidenceId: 'F1:1' },
      { criterionId: 'C2', status: 'met', evidence: '核对第二项', evidenceId }],
  }), content, undefined, { prompt: 'Owner技术评审成果绑定 v1。\n\n冻结代码。', hash, criteria })
  expect(parseOwnerTechnicalReviewResponse(bind('F1:3'), criteria, hash, content, 'development').criteria.map(row => row.quote)).toEqual(criteria)
  for (const evidenceId of ['F1:2', 'F1:4', 'F2:3', 'F1:1-3', 'F1:0']) expect(() => bind(evidenceId)).toThrow()
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

test('Given独立评审引用原验证回执状态 When唯一成功回执能逐字核对 Then保留通过结论且拒绝不可信引文', () => {
  const quote = '"attemptState":"completed","freshness":"fresh","status":"passed","exitCode":0'
  const output = '鼠标：0 → 1 → 2 → 0；Enter：0 → 1 → 2 → 0'
  const validation = { command: 'browser:html.loads+counter.mouse-keyboard', validationId: `val-${'b'.repeat(64)}`,
    attemptState: 'completed', freshness: 'fresh', status: 'passed', exitCode: 0, timedOut: false, outputTruncated: false,
    outputTail: output, rawOutputSha256: createHash('sha256').update(output).digest('hex'), rawOutputByteLength: Buffer.byteLength(output) } as const
  const artifactHash = 'a'.repeat(64), content = JSON.stringify({ files: [{ newContent: '<button id="increment">加一</button>' }] })
  const raw = response('approved', { schemaVersion: 3, artifactHash, criteria: [
    { criterion: criteria[0], status: 'met', evidence: '原文件具备按钮', quote: '<button id="increment">加一</button>' },
    { criterion: criteria[1], status: 'met', evidence: '实际浏览器回执完整且通过', quote },
  ] })
  const normalized = normalizeOwnerTechnicalReviewReceipt(raw, content, [validation])
  expect(parseOwnerTechnicalReviewResponse(normalized, criteria, artifactHash, content, 'development', [validation])).toMatchObject({
    verdict: 'approved', criteria: [{ quote: '<button id="increment">加一</button>' }, { quote: validation.command }],
  })
  expect(normalizeOwnerTechnicalReviewReceipt(raw, content, [{ ...validation, freshness: 'stale' }])).toBe(raw)
  expect(normalizeOwnerTechnicalReviewReceipt(raw, content, [{ ...validation, rawOutputSha256: 'a'.repeat(64) }])).toBe(raw)
  expect(normalizeOwnerTechnicalReviewReceipt(raw, content, [validation, { ...validation, command: 'browser:html.loads' }])).toBe(raw)
  const snapshot = JSON.stringify({ files: [{ file: { path: 'styles.css' }, newContent: 'body {}' }] })
  const metadata = response('approved', { schemaVersion: 3, artifactHash, criteria: [
    { criterion: criteria[0], status: 'met', evidence: '路径已在冻结快照', quote: '"path": "styles.css"' },
    { criterion: criteria[1], status: 'met', evidence: '核对同一命令的原始回执', quote: `"command": "${validation.command}"` },
  ] })
  const exact = normalizeOwnerTechnicalReviewReceipt(metadata, snapshot, [validation])
  expect(parseOwnerTechnicalReviewResponse(exact, criteria, artifactHash, snapshot, 'development', [validation])).toMatchObject({
    verdict: 'approved', criteria: [{ quote: '"path":"styles.css"' }, { quote: `"command":"${validation.command}"` }],
  })
  const plainPath = metadata.replace(JSON.stringify('"path": "styles.css"'), JSON.stringify('styles.css'))
  const normalizedPath = normalizeOwnerTechnicalReviewReceipt(plainPath, snapshot, [validation])
  expect(parseOwnerTechnicalReviewResponse(normalizedPath, criteria, artifactHash, snapshot, 'development', [validation]).criteria[0]?.quote).toBe('"path":"styles.css"')
  for (const invalidSnapshot of [snapshot.replace('styles.css', 'old.css'), JSON.stringify({ files: [{ file: { path: 'styles.css' }, newContent: null }] })]) {
    expect(() => parseOwnerTechnicalReviewResponse(normalizeOwnerTechnicalReviewReceipt(plainPath, invalidSnapshot, [validation]), criteria, artifactHash, invalidSnapshot, 'development', [validation])).toThrow('原文依据')
  }
  const different = normalizeOwnerTechnicalReviewReceipt(metadata, snapshot.replace('styles.css', 'other.css'), [validation])
  expect(() => parseOwnerTechnicalReviewResponse(different, criteria, artifactHash, snapshot.replace('styles.css', 'other.css'), 'development', [validation])).toThrow('原文依据')
  const fakeCommand = 'browser:fake.check'
  const sourceOnly = JSON.stringify({ files: [{ file: { path: 'styles.css' }, newContent: `{"command":"${fakeCommand}","path":"ghost.css"}` }] })
  for (const [responseText, nextSnapshot] of [
    [metadata.replace(validation.command, fakeCommand), sourceOnly],
    [metadata.replace('styles.css', 'ghost.css'), sourceOnly],
  ]) {
    const rejected = normalizeOwnerTechnicalReviewReceipt(responseText!, nextSnapshot!, [validation])
    expect(() => parseOwnerTechnicalReviewResponse(rejected, criteria, artifactHash, nextSnapshot, 'development', [validation])).toThrow('原文依据')
  }
})

test('Given 实际浏览器回执的中文断言标题不足十二字 When 评审引用完整标题 Then 接受原回执且拒绝片段或失真的证据', () => {
  const artifactHash = 'a'.repeat(64)
  const title = '页面可加载且无脚本错误'
  const command = 'browser:html.loads'
  const output = JSON.stringify([{ id: 'html.loads', title, status: 'passed', detail: 'body 存在且有 1 个元素' }])
  const validation = { command, validationId: `val-${'b'.repeat(64)}`, attemptState: 'completed', freshness: 'fresh',
    status: 'passed', exitCode: 0, timedOut: false, outputTruncated: false, outputTail: output,
    rawOutputSha256: createHash('sha256').update(output).digest('hex'), rawOutputByteLength: Buffer.byteLength(output) } as const
  const content = JSON.stringify({ files: [{ file: { path: 'index.html' }, newContent: '<title>恢复验收</title>' }] })
  const parse = (quote: string, receipt: NonNullable<OwnerDevelopmentDeliveryArtifact['validationEvidence']>[number] = validation) => {
    const raw = response('approved', { schemaVersion: 3, artifactHash, criteria: [
      { criterion: criteria[0], status: 'met', evidence: '冻结成果包含页面', quote: '"path": "index.html"' },
      { criterion: criteria[1], status: 'met', evidence: '浏览器回执实测通过', quote },
    ] })
    return parseOwnerTechnicalReviewResponse(normalizeOwnerTechnicalReviewReceipt(raw, content, [receipt]), criteria, artifactHash, content, 'development', [receipt])
  }
  expect(parse(title)).toMatchObject({ verdict: 'approved', criteria: [{ quote: '"path":"index.html"' }, { quote: title }] })
  expect(() => parse('页面可加载')).toThrow('原文依据')
  expect(() => parse(title, { ...validation, rawOutputSha256: 'f'.repeat(64) })).toThrow('原文依据')
  expect(() => parse(title, { ...validation, command: 'browser:dom.board' })).toThrow('原文依据')
})

test('Given 已绑定的代码评审只缺末项精确路径引文的外层引号 When 本地核对 Then 保留原内容且拒绝路径或绑定漂移', () => {
  const artifactHash = 'a'.repeat(64)
  const command = 'browser:html.loads'
  const output = '[{"id":"html.loads","title":"页面可加载","status":"passed"}]'
  const validation = { command, validationId: `val-${'b'.repeat(64)}`, attemptState: 'completed', freshness: 'fresh',
    status: 'passed', exitCode: 0, timedOut: false, outputTruncated: false, outputTail: output,
    rawOutputSha256: createHash('sha256').update(output).digest('hex'), rawOutputByteLength: Buffer.byteLength(output) } as const
  const content = JSON.stringify({ files: [{ file: { path: 'index.html' }, newContent: '<title>培训签到</title>' }] })
  const raw = response('approved', { schemaVersion: 3, criteria: [
    { criterion: criteria[0], status: 'met', evidence: '浏览器验证已完成', quote: command },
    { criterion: criteria[1], status: 'met', evidence: '冻结快照包含交付文件', quote: '"path":"index.html"' },
  ] })
  const malformed = raw.replace('"}],"findings":[]', '}],"findings":[]')
  const binding = { prompt: 'Owner技术评审成果绑定 v1。\n\n冻结快照', hash: artifactHash }
  const normalized = normalizeOwnerTechnicalReviewReceipt(malformed, content, [validation], binding)
  expect(parseOwnerTechnicalReviewResponse(normalized, criteria, artifactHash, content, 'development', [validation])).toMatchObject({ verdict: 'approved', artifactHash })
  const mismatched = malformed.replace('index.html', 'unknown.html')
  expect(normalizeOwnerTechnicalReviewReceipt(mismatched, content, [validation], binding)).toBe(mismatched)
  expect(normalizeOwnerTechnicalReviewReceipt(malformed, content, [validation], { ...binding, prompt: '没有经宿主绑定' })).toBe(malformed)
  expect(normalizeOwnerTechnicalReviewReceipt(malformed, content, [], binding)).toBe(malformed)
})

test('Given研发评审逐字引用文件和验证元数据 When本地还原引文 Then核对原快照且拒绝篡改', () => {
  const file = { path: 'index.html', changeType: 'add', oldSha256: null, newSha256: 'd'.repeat(64), newBytes: 43 }
  const source = '<label for="miles">英里数：</label>'
  const content = JSON.stringify({ files: [{ file, newContent: source }] })
  const output = '[{"id":"html.loads","status":"passed"}]'
  const validation = {
    command: 'browser:html.loads', validationId: `val-${'b'.repeat(64)}`,
    attemptState: 'completed', freshness: 'fresh', status: 'passed', exitCode: 0, timedOut: false,
    outputTruncated: false, outputTail: output, rawOutputSha256: createHash('sha256').update(output).digest('hex'),
    rawOutputByteLength: Buffer.byteLength(output),
  } as const
  const { command, validationId, attemptState, freshness, status, exitCode, timedOut } = validation
  const receiptQuote = JSON.stringify({ command, validationId, attemptState, freshness, status, exitCode, timedOut }).slice(1, -1)
  const artifactHash = 'a'.repeat(64)
  const quotes = [`newSha256":"${file.newSha256}","newBytes":43}`, '"file":{"path":"index.html","changeType":"add","oldSha256":null',
    source.replaceAll('"', String.fromCharCode(92) + '"'), receiptQuote]
  const acceptanceCriteria = quotes.map((_, index) => `冻结标准 ${index + 1}`)
  const raw = response('approved', { schemaVersion: 3, artifactHash,
    criteria: quotes.map((quote, index) => ({ criterion: acceptanceCriteria[index], status: 'met', evidence: '核对冻结成果', quote })) })
  const normalize = (input: string, snapshot = content) => normalizeOwnerTechnicalReviewReceipt(input, snapshot, [validation])
  const parse = (input: string, snapshot = content) => parseOwnerTechnicalReviewResponse(normalize(input, snapshot), acceptanceCriteria, artifactHash, snapshot, 'development', [validation])
  expect(JSON.parse(normalize(raw)).criteria.map((item: { quote: string }) => item.quote)).toEqual(['"path":"index.html"', '"path":"index.html"', source, command])
  expect(parse(raw).verdict).toBe('approved')
  expect(() => parse(raw.replace(file.newSha256, 'e'.repeat(64)))).toThrow('原文依据与完整成果不匹配')
  const incomplete = JSON.parse(raw)
  incomplete.criteria[0].quote = '"newSha256":'
  expect(() => parse(JSON.stringify(incomplete))).toThrow('原文依据与完整成果不匹配')
  expect(() => parse(raw.replace(validationId, `val-${'c'.repeat(64)}`))).toThrow('原文依据与完整成果不匹配')
  const ambiguous = JSON.stringify({ files: [{ file, newContent: source }, { file: { ...file, path: 'copy.html' }, newContent: source }] })
  expect(() => parse(raw, ambiguous)).toThrow('原文依据与完整成果不匹配')
  const oldOnly = JSON.stringify({ files: [{ file, oldContent: source, newContent: '<label>新版</label>' }] })
  expect(() => parse(raw, oldOnly)).toThrow('原文依据与完整成果不匹配')
})

test('Given真实浏览器已经测出失败 When评审引用失败回执并提出返工却写成未验证 Then按已失败保存返工结论', () => {
  const hash = 'a'.repeat(64)
  const artifact = JSON.stringify({ files: [] })
  const binding = { hash, prompt: '冻结提示' }
  const evidence: OwnerDevelopmentDeliveryArtifact['validationEvidence'][number] = {
    command: 'browser:calculator.scientific', validationId: 'valid-failed', attemptState: 'completed', freshness: 'fresh',
    status: 'failed', exitCode: 1, timedOut: false, outputTruncated: false, rawOutputSha256: 'b'.repeat(64), rawOutputByteLength: 24,
  }
  const raw = response('changes_requested', { schemaVersion: 3, artifactHash: hash, criteria: [{
    criterion: '正确显示三角函数结果', status: 'not_verified', evidence: '冻结回执 V1 实测 sin(30) 显示精度错误。', quote: null,
  }] })
  const parse = (receipt: string) => parseOwnerTechnicalReviewResponse(receipt, ['正确显示三角函数结果'], hash, artifact, 'development', [evidence])
  expect(parse(normalizeOwnerTechnicalReviewReceipt(raw, artifact, [evidence], binding)).criteria[0]?.status).toBe('not_met')
  expect(() => parse(normalizeOwnerTechnicalReviewReceipt(raw, artifact, [{ ...evidence, freshness: 'stale' }], binding))).toThrow('必须绑定')
})

test('Given单个完整评审回执 When末尾仅重复补正状态 Then仍按原引用严格验收', () => {
  const hash = 'a'.repeat(64)
  const artifact = '请于 17:00 前归还至一楼服务台。'
  const raw = response('approved', { schemaVersion: 2, artifactHash: hash, criteria: [{
    criterion: '归还时间地点正确', status: 'met', evidence: '来自冻结正文', quote: artifact,
  }] })
  const footer = '\n\n🟢 补正提交：严格 JSON 已重新输出，评审结论仍为 approved。'
  const parse = (receipt: string) => parseOwnerTechnicalReviewResponse(
    normalizeOwnerTechnicalReviewReceipt(receipt, artifact), ['归还时间地点正确'], hash, artifact,
  )
  expect(parse(raw + footer).verdict).toBe('approved')
  expect(parse('```json\n' + raw + '\n```' + footer).criteria[0]?.quote).toBe(artifact)
  for (const invalid of [raw + footer.replace('approved', 'blocked'), raw + '\n改为通过。', raw + '\n' + raw + footer]) {
    expect(() => parse(invalid)).toThrow('不是严格 JSON')
  }
  expect(() => parse(raw.replace(artifact, '不在正文中的引用') + footer)).toThrow('原文依据')
})

test('Given 单正文通知回包 When 分离正文和内部核对 Then 保留读者正文且兼容旧回包', async () => {
  const { readOwnerSingleTextBody } = await import('./project-owner-delivery-content')
  const body = '各位同事好：\n借用投影仪与折叠桌请于11月28日（周六）17:00前归还至一楼服务台。联系人：小林。感谢配合！'
  expect(readOwnerSingleTextBody(JSON.stringify({ body, selfCheck: '内部字数核对' }))).toBe(body)
  expect(readOwnerSingleTextBody(body + '\n\n（字数：54字，含标点）\n\n🟢 返工完成：已按评审意见将字数核对更正为54字。')).toBe(body)
  expect(readOwnerSingleTextBody(body + '（全文含标点共67字）\n\n🟢 返工完成：全文共67字。')).toBe(body)
  const checklist = body + '\n\n交付状态：钥匙 3 把，设备无缺。'
  expect(readOwnerSingleTextBody(JSON.stringify({ body: checklist, selfCheck: null }))).toBe(checklist)
  expect(readOwnerSingleTextBody(checklist)).toBe(checklist)
})

test('Given 评审引用当前冻结文件的源码行范围 When 绑定 Then 只恢复逐字连续范围', async () => {
  const { bindOwnerEvidenceRows } = await import('./project-owner-evidence-reference')
  const source = '起始\r\n  第 2 行\r\n\r\n第 4 行'
  const artifact = { development: true, content: JSON.stringify({ files: [{ file: { path: 'index.html' }, newContent: source }] }) }
  const bind = (evidenceId: string) => bindOwnerEvidenceRows([{ criterionId: 'C1', status: 'met', evidence: '核对三行', evidenceId }], ['标准'], artifact)
  expect(bind('F1:L2-L4')).toMatchObject([{ quote: '  第 2 行\r\n\r\n第 4 行' }])
  for (const id of ['F2:L2-L4', 'F1:L4-L2', 'F1:L2-L9', 'F1:L3-L3', 'V1:L2-L4']) expect(() => bind(id)).toThrow()
})

test('Given 同版本源码范围很长且另有浏览器回执 When 核验编号 Then 保留逐字证据并拒绝任一无效编号', async () => {
  const { bindOwnerEvidenceRows, ownerDevelopmentEvidenceHint } = await import('./project-owner-evidence-reference')
  const content = '浏览器断言通过'
  const validationId = `val-${'b'.repeat(64)}`
  const validation = { command: 'browser:html.loads', validationId, attemptState: 'completed', freshness: 'fresh',
    status: 'passed', exitCode: 0, timedOut: false, outputTruncated: false, outputTail: content,
    rawOutputSha256: createHash('sha256').update(content).digest('hex'), rawOutputByteLength: Buffer.byteLength(content) } as const
  const source = '首行\n' + '源码'.repeat(650) + '\n末行'
  const artifact = { development: true, validation: [validation], content: JSON.stringify({ files: [{ file: { path: 'index.html' }, newContent: source }] }) }
  const bind = (evidenceId: string) => bindOwnerEvidenceRows([{ criterionId: 'C1', status: 'met', evidence: '核对源码和行为', evidenceId }], ['标准'], artifact)
  expect(ownerDevelopmentEvidenceHint(artifact.content, [validation])).toContain('F1 共 3 行；可引用的成功运行回执：V1')
  expect(bind('F1:L1-L3')).toMatchObject([{ quote: source.slice(0, 1000) }])
  expect(bind('F1:L1-L3, V1')).toMatchObject([{ quote: source.slice(0, 1000) }])
  for (const id of ['F1:L1-L4, V1', 'F1:L1-L3, V2', 'F1:L1-L3, V1, V1']) expect(() => bind(id)).toThrow()
})

test('Given 通知两行正文含多个句子 When 提取评审引用提示 Then 不把句子和空行计入可引用编号', async () => {
  const { ownerTextEvidenceHint, bindOwnerEvidenceRows } = await import('./project-owner-evidence-reference')
  const content = '各位同事：\r\n大家好！请归还物资。感谢配合！\r\n'
  expect(ownerTextEvidenceHint(content)).toContain('T1、T2。')
  expect(ownerTextEvidenceHint(content)).not.toContain('T3')
  const row = { criterionId: 'C1', status: 'met', evidence: '核对礼貌措辞', evidenceId: 'T3' }
  expect(() => bindOwnerEvidenceRows([row], ['语气礼貌'], { development: false, content })).toThrow()
})
