import { describe, expect, test } from 'bun:test'
import type { ToolSelectionRun } from './tool-selection-experiment'
import {
  buildToolSelectionPrompt,
  parseToolSelection,
  runToolSelectionExperiment,
  summarizeToolSelection,
  TOOL_SELECTION_SYSTEM_PROMPT,
} from './tool-selection-experiment'
import { buildSelectionCatalog, getSelectionSchemaBody, TOOL_SELECTION_CASES } from './tool-selection-fixture'

const catalog = buildSelectionCatalog()

function okDelegate(): Parameters<typeof runToolSelectionExperiment>[0]['delegate'] {
  return async ({ caseId, variant, task }) => {
    if (variant === 'full_schema') {
      expect(task).toContain('"type":"object"')
      expect(task).toContain(getSelectionSchemaBody('builtin:read-file:schema').slice(0, 20))
    } else {
      expect(task).toContain('可用能力目录（30 项）')
      expect(task).not.toContain('"type": "object"')
    }
    const expected = TOOL_SELECTION_CASES.find((testCase) => testCase.id === caseId)!.expectedToolId
    return { text: `{"selectedId":"${expected}","confidence":"high"}`, inputTokens: variant === 'full_schema' ? 8000 : 1200, outputTokens: 20, cacheStatus: 'miss' }
  }
}

describe('M4-04 tool selection experiment', () => {
  test('summary prompt carries the catalog without any parameter schema', () => {
    const prompt = buildToolSelectionPrompt({ testCase: TOOL_SELECTION_CASES[0]!, catalog, variant: 'summary_on_demand' })
    expect(prompt).toContain('[builtin:create-event] CreateCalendarEvent')
    expect(prompt).not.toContain('"type"')
  })

  test('parses selection output tolerantly and fails closed on garbage', () => {
    expect(parseToolSelection('```json\n{"selectedId":"builtin:time-now"}\n```')).toEqual({ selectedId: 'builtin:time-now' })
    expect(parseToolSelection('前置说明\n{"selectedId":"builtin:time-now"}').selectedId).toBe('builtin:time-now')
    expect(parseToolSelection('no json here').protocolError).toBeDefined()
    expect(parseToolSelection('{"confidence":"high"}').protocolError).toContain('selectedId 缺失')
  })

  test('runs the full matrix with resume support', async () => {
    const seen: string[] = []
    const runs = await runToolSelectionExperiment({
      cases: TOOL_SELECTION_CASES.slice(0, 1),
      catalog,
      runsPerCase: 2,
      delegate: okDelegate(),
      alreadyCompleted: new Set(['SEL-01:full_schema:1']),
      now: (() => { let tick = 0; return () => (tick += 10) })(),
      onRun: (run) => seen.push(`${run.caseId}:${run.variant}:${run.run}`),
    })
    expect(seen).toEqual(['SEL-01:full_schema:2', 'SEL-01:summary_on_demand:1', 'SEL-01:summary_on_demand:2'])
    expect(runs.every((run) => run.correct)).toBe(true)
  })

  test('gate passes only when summary accuracy matches baseline and tokens shrink', () => {
    const run = (overrides: Partial<ToolSelectionRun>): ToolSelectionRun => ({
      caseId: 'SEL-01', variant: 'full_schema', run: 1, status: 'ok', selectedId: 'builtin:delete-file',
      correct: true, inputTokens: 8000, outputTokens: 20, cacheStatus: 'miss', durationMs: 10, ...overrides,
    })
    const passing = summarizeToolSelection([
      run({}),
      run({ variant: 'summary_on_demand', inputTokens: 1200 }),
    ])
    expect(passing.passed).toBe(true)

    const lessAccurate = summarizeToolSelection([
      run({}),
      run({ variant: 'summary_on_demand', inputTokens: 1200, correct: false }),
    ])
    expect(lessAccurate.passed).toBe(false)
    expect(lessAccurate.reasons.some((reason) => reason.includes('accuracy'))).toBe(true)

    const noSavings = summarizeToolSelection([
      run({}),
      run({ variant: 'summary_on_demand', inputTokens: 8000 }),
    ])
    expect(noSavings.passed).toBe(false)
    expect(noSavings.reasons.some((reason) => reason.includes('token reduction'))).toBe(true)
  })

  test('system prompt demands pure JSON', () => {
    expect(TOOL_SELECTION_SYSTEM_PROMPT).toContain('只输出一个 JSON 对象')
  })
})
