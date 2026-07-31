import { describe, expect, test } from 'bun:test'
import { validateWorkflowOutput } from './workflow-output-schema'

describe('Workflow output schema', () => {
  const schema = { type: 'object', required: ['summary', 'count'], properties: { summary: { type: 'string' }, count: { type: 'integer' } } }
  test('Given matching structured output When validated Then it passes', () => expect(validateWorkflowOutput({ summary: 'ok', count: 2 }, schema)).toEqual({ valid: true, errors: [] }))
  test('Given missing or invalid output When validated Then it returns readable errors', () => {
    const result = validateWorkflowOutput({ summary: 1 }, schema)
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('$.count 为必填字段')
    expect(result.errors.join('\n')).toContain('$.summary 必须是字符串')
  })
})
