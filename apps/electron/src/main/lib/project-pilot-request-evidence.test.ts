import { expect, test } from 'bun:test'
import { derivePilotRequestEnvelope, pilotRequestFingerprint, registerPilotPriceEvidenceForTests }
  from './project-pilot-request-evidence'

const evidence = {
  evidenceId: 'approved-ev', providerKind: 'openai' as const, model: 'model-a',
  inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 6_000_000, extraCostCeilingMicros: 30,
  maxModelInputTokens: 4_000, maxModelOutputTokens: 200, reviewedAt: '2026-09-28', source: 'test-fixture',
}
registerPilotPriceEvidenceForTests(evidence)

test('Given 未审核价格 ID When 生成请求包络 Then 一律拒绝', () => {
  expect(() => derivePilotRequestEnvelope({ body: '{"model":"model-a","max_tokens":10}', priceEvidenceId: 'forged' }))
    .toThrow('未审核入库')
  expect(() => derivePilotRequestEnvelope({ body: '', priceEvidenceId: 'approved-ev' })).toThrow('请求体为空')
})

test('Given 已审核证据与 openai 请求体 When 生成包络 Then 上界与指纹绑定到最终字节', () => {
  const body = '{"model":"model-a","max_tokens":150,"messages":[{"role":"user","content":"hi"}]}'
  const derived = derivePilotRequestEnvelope({ body, priceEvidenceId: 'approved-ev' })
  expect(derived.requestEvidenceId).toBe(pilotRequestFingerprint(body))
  expect(derived.outputTokenCeiling).toBe(150)
  expect(derived.inputTokenCeiling).toBe(Math.min(Buffer.byteLength(body, 'utf8'), 4_000))
  expect([derived.inputRateMicrosPerMillion, derived.outputRateMicrosPerMillion, derived.extraCostCeilingMicros])
    .toEqual([2_000_000, 6_000_000, 30])
  // 逐字节一致：仅空白差异也产生不同指纹，防止换包络复用旧预留。
  const spaced = '{"model": "model-a", "max_tokens": 150, "messages": [{"role": "user", "content": "hi"}]}'
  expect(derivePilotRequestEnvelope({ body: spaced, priceEvidenceId: 'approved-ev' }).requestEvidenceId)
    .not.toBe(derived.requestEvidenceId)
})

test('Given 请求体缺输出上限或与证据冲突 When 生成包络 Then fail-closed 或夹紧', () => {
  expect(() => derivePilotRequestEnvelope({ body: '{"model":"model-a","messages":[]}', priceEvidenceId: 'approved-ev' }))
    .toThrow('缺少强制输出上限')
  expect(() => derivePilotRequestEnvelope({ body: '{"model":"model-b","max_tokens":10}', priceEvidenceId: 'approved-ev' }))
    .toThrow('缺少模型标识或与价格证据不一致')
  // 缺 model 字段同样拒绝；出口核验的 URL 模型（verifiedModel）可补足绑定但不得与 body 冲突。
  expect(() => derivePilotRequestEnvelope({ body: '{"max_tokens":10}', priceEvidenceId: 'approved-ev' }))
    .toThrow('缺少模型标识或与价格证据不一致')
  expect(() => derivePilotRequestEnvelope({ body: '{"model":"model-a","max_tokens":10}', priceEvidenceId: 'approved-ev', verifiedModel: 'model-a' }))
    .not.toThrow()
  expect(() => derivePilotRequestEnvelope({ body: '{"model":"model-a","max_tokens":10}', priceEvidenceId: 'approved-ev', verifiedModel: 'model-b' }))
    .toThrow('缺少模型标识或与价格证据不一致')
  expect(() => derivePilotRequestEnvelope({ body: '{"model":"model-a","max_tokens":0}', priceEvidenceId: 'approved-ev' }))
    .toThrow('输出上限无效')
  expect(() => derivePilotRequestEnvelope({ body: 'not-json', priceEvidenceId: 'approved-ev' })).toThrow('有效 JSON')
  // 请求字段超出模型审核上界时被夹紧，不得按请求方声明放行。
  const clamped = derivePilotRequestEnvelope({ body: '{"model":"model-a","max_tokens":500}', priceEvidenceId: 'approved-ev' })
  expect(clamped.outputTokenCeiling).toBe(200)
  const dual = derivePilotRequestEnvelope({
    body: '{"model":"model-a","max_tokens":500,"max_completion_tokens":80}', priceEvidenceId: 'approved-ev',
  })
  expect(dual.outputTokenCeiling).toBe(80)
})

test('Given anthropic 或 google 证据 When 生成包络 Then 按各自协议读取输出上限', () => {
  registerPilotPriceEvidenceForTests({
    ...evidence, evidenceId: 'approved-anthropic', providerKind: 'anthropic', model: 'model-anthropic',
  })
  const anthropic = derivePilotRequestEnvelope({
    body: '{"model":"model-anthropic","max_tokens":120,"messages":[]}', priceEvidenceId: 'approved-anthropic',
  })
  expect(anthropic.outputTokenCeiling).toBe(120)
  // google 协议模型在 URL：必须由出口核验后经 verifiedModel 传入，缺失即拒。
  registerPilotPriceEvidenceForTests({
    ...evidence, evidenceId: 'approved-google', providerKind: 'google', model: 'model-google',
  })
  expect(() => derivePilotRequestEnvelope({
    body: '{"contents":[],"generationConfig":{"maxOutputTokens":90}}', priceEvidenceId: 'approved-google',
  })).toThrow('缺少模型标识')
  const google = derivePilotRequestEnvelope({
    body: '{"contents":[],"generationConfig":{"maxOutputTokens":90}}', priceEvidenceId: 'approved-google',
    verifiedModel: 'model-google',
  })
  expect(google.outputTokenCeiling).toBe(90)
  expect(() => derivePilotRequestEnvelope({
    body: '{"contents":[]}', priceEvidenceId: 'approved-google', verifiedModel: 'model-google',
  })).toThrow('缺少强制输出上限')
})

test('Given 已入库的 glm-5.3-flash 官方证据 When 生成包络 Then 使用审核牌价并夹紧模型上限', () => {
  const body = '{"model":"glm-5.3-flash","max_tokens":4096,"messages":[{"role":"user","content":"hi"}]}'
  const derived = derivePilotRequestEnvelope({ body, priceEvidenceId: 'zai-glm-5.3-flash-2026-09-28' })
  expect(derived.requestEvidenceId).toBe(pilotRequestFingerprint(body))
  expect(derived.outputTokenCeiling).toBe(4096)
  expect(derived.inputTokenCeiling).toBe(Math.min(Buffer.byteLength(body, 'utf8'), 1_000_000))
  expect([derived.inputRateMicrosPerMillion, derived.outputRateMicrosPerMillion, derived.extraCostCeilingMicros])
    .toEqual([150_000, 500_000, 0])
  // 请求输出上限超出官方 128K 时夹紧到 131072。
  const clamped = derivePilotRequestEnvelope({
    body: '{"model":"glm-5.3-flash","max_tokens":999999}', priceEvidenceId: 'zai-glm-5.3-flash-2026-09-28',
  })
  expect(clamped.outputTokenCeiling).toBe(131_072)
})

test('Given 多模态内容或未审核工具 When 生成包络 Then 一律拒绝', () => {
  const evidenceId = 'zai-glm-5.3-flash-2026-09-28'
  const multimodal = '{"model":"glm-5.3-flash","max_tokens":100,"messages":[{"role":"user","content":'
    + '[{"type":"text","text":"hi"},{"type":"image_url","image_url":{"url":"https://example.com/a.png"}}]}]}'
  expect(() => derivePilotRequestEnvelope({ body: multimodal, priceEvidenceId: evidenceId })).toThrow('多模态内容')
  expect(() => derivePilotRequestEnvelope({
    body: '{"model":"glm-5.3-flash","max_tokens":100,"tools":[{"type":"web_search"}]}',
    priceEvidenceId: evidenceId,
  })).toThrow('内置工具')
  expect(() => derivePilotRequestEnvelope({
    body: '{"model":"glm-5.3-flash","max_tokens":100,"tools":[{"type":"function","function":{"name":"f"}}]}',
    priceEvidenceId: evidenceId,
  })).not.toThrow()
  // 边界形态：content 为数字、body 为 JSON null 字面量。
  expect(() => derivePilotRequestEnvelope({
    body: '{"model":"glm-5.3-flash","max_tokens":10,"messages":[{"role":"user","content":123}]}',
    priceEvidenceId: evidenceId,
  })).toThrow('消息格式无法核验')
  expect(() => derivePilotRequestEnvelope({ body: 'null', priceEvidenceId: evidenceId })).toThrow('JSON 对象')
})

test('Given google 证据 When contents 携带非文本 part Then 拒绝多模态', () => {
  registerPilotPriceEvidenceForTests({
    ...evidence, evidenceId: 'approved-google2', providerKind: 'google', model: 'model-google',
  })
  expect(() => derivePilotRequestEnvelope({
    body: '{"contents":[{"parts":[{"inlineData":{"mimeType":"image/png","data":"aGk="}}]}],"generationConfig":{"maxOutputTokens":50}}',
    priceEvidenceId: 'approved-google2', verifiedModel: 'model-google',
  })).toThrow('多模态内容')
  expect(() => derivePilotRequestEnvelope({
    body: '{"contents":[{"parts":[{"text":"hi"}]}],"generationConfig":{"maxOutputTokens":50}}',
    priceEvidenceId: 'approved-google2', verifiedModel: 'model-google',
  })).not.toThrow()
})

test('Given 字段非法的证据 When 注册 Then 直接拒绝入库', () => {
  expect(() => registerPilotPriceEvidenceForTests({ ...evidence, evidenceId: '  ' })).toThrow('身份字段无效')
  expect(() => registerPilotPriceEvidenceForTests({ ...evidence, evidenceId: 'bad-rates', inputMicrosPerMillion: 0 }))
    .toThrow('数值字段无效')
  expect(() => registerPilotPriceEvidenceForTests({ ...evidence, evidenceId: 'bad-kind', providerKind: 'openai-compatible' as never }))
    .toThrow('身份字段无效')
})
