import { describe, expect, test } from 'bun:test'
import { evaluateContextPacket, evaluateContextCompactionGoldenSet } from './context-compaction-evaluator'
import { CONTEXT_COMPACTION_GOLDENS } from './context-compaction-goldens'

describe('上下文压缩 Golden 评测', () => {
  test('评测结构化包是否保留事实、决策与未完成任务', () => {
    expect(evaluateContextPacket({ version: 1, summary: 'x', facts: ['模型是 kimi-k3'], decisions: ['窗口按 1M'], openTasks: ['完成 P5'], importantFiles: [], toolState: [] }, {
      id: 'kimi-k3-context',
      requiredFacts: ['kimi-k3'],
      requiredDecisions: ['1M'],
      requiredOpenTasks: ['P5'],
    })).toEqual({ caseId: 'kimi-k3-context', passed: true, score: 1, missing: [] })
  })

  test("缺失关键待办会降低分数并给出字段级原因", () => {
    expect(evaluateContextPacket({ version: 1, summary: "x", facts: ["模型是 kimi-k3"], decisions: [], openTasks: [], importantFiles: [], toolState: [] }, {
      id: "missing-task",
      requiredFacts: ["kimi-k3"],
      requiredOpenTasks: ["P5"],
    })).toEqual({ caseId: "missing-task", passed: false, score: 0.5, missing: ["openTasks:P5"] })
  })

  test('质量门覆盖长会话、多工具和溢出恢复三类 Golden 场景', () => {
    expect(evaluateContextCompactionGoldenSet(CONTEXT_COMPACTION_GOLDENS)).toEqual({
      passed: true,
      score: 1,
      evaluations: expect.arrayContaining([
        expect.objectContaining({ caseId: 'long-running-plan', passed: true }),
        expect.objectContaining({ caseId: 'multi-tool-state', passed: true }),
        expect.objectContaining({ caseId: 'overflow-recovery', passed: true }),
      ]),
    })
  })
})
