import { describe, expect, test } from 'bun:test'
import { parseSubtaskResult, TYPED_SUBTASK_RESULT_PROTOCOL_PROMPT } from './subtask-result-parser'

const evidence = {
  kind: 'test_result',
  sourceId: 'test:context-projector',
  locator: 'context-projector.test.ts',
  verified: true,
}

describe('parseSubtaskResult', () => {
  test('given a typed-v1 child when it receives protocol instructions then evidence is explicitly required for high confidence', () => {
    expect(TYPED_SUBTASK_RESULT_PROTOCOL_PROMPT).toContain('高置信主张必须附带 evidence')
    expect(TYPED_SUBTASK_RESULT_PROTOCOL_PROMPT).toContain('```json')
  })

  test('given a valid typed-v1 response when parsing then it preserves evidence-backed claims and artifacts', () => {
    const parsed = parseSubtaskResult(`结果如下：\n\n\`\`\`json
${JSON.stringify({
  protocolVersion: 1,
  taskId: 'untrusted-child-id',
  status: 'completed',
  summary: '已验证投影行为。',
  claims: [{ statement: '投影稳定。', confidence: 'high', evidence: [evidence], verified: true }],
  artifacts: [{ kind: 'test_report', title: '回归测试', content: '通过', evidence: [evidence] }],
  unverified: [],
  recommendedNextSteps: ['持久化结果'],
})}
\`\`\``, 'parent-task')

    expect(parsed.protocolError).toBeUndefined()
    expect(parsed.result).toMatchObject({
      taskId: 'parent-task',
      status: 'completed',
      claims: [{ statement: '投影稳定。', confidence: 'high', evidence: [evidence], verified: true }],
      artifacts: [{ kind: 'test_report', title: '回归测试' }],
    })
  })

  test('given a high-confidence claim without evidence when parsing then it is downgraded and declared unverified', () => {
    const parsed = parseSubtaskResult(JSON.stringify({
      protocolVersion: 1,
      status: 'completed',
      summary: '完成',
      claims: [{ statement: '未经验证的断言', confidence: 'high', evidence: [], verified: true }],
      artifacts: [],
      unverified: [],
      recommendedNextSteps: [],
    }), 'task-1')

    expect(parsed.result.claims).toEqual([{
      statement: '未经验证的断言',
      confidence: 'medium',
      evidence: [],
      verified: false,
    }])
    expect(parsed.result.unverified).toContain('主张缺少 evidence，已从 high 降级：未经验证的断言')
  })

  test('given malformed protocol when parsing then it becomes partial without claims or artifacts', () => {
    const parsed = parseSubtaskResult('普通文本结论', 'task-2')

    expect(parsed).toMatchObject({
      protocolError: '未找到 typed-v1 JSON 对象',
      result: {
        taskId: 'task-2',
        status: 'partial',
        claims: [],
        artifacts: [],
        unverified: ['未找到 typed-v1 JSON 对象'],
      },
    })
  })
})
