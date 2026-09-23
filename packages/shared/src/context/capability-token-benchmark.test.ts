import type { CapabilityTokenScoreboard } from '@gravitas/shared'
import { describe, expect, test } from 'bun:test'
import type { CapabilityDescriptor } from './capability'
import { createCapabilityCatalog } from './capability'
import { projectCapabilitySchemas } from './capability-schema-projection'
import { renderCapabilitySummary } from './capability-summary'
import { estimateCapabilityTokens, runCapabilityTokenBenchmark } from './capability-token-benchmark'

const SCHEMA_BODY = JSON.stringify({
  type: 'object',
  properties: {
    path: { type: 'string', description: '目标路径' },
    content: { type: 'string', description: '写入内容，最长 64KB' },
    mode: { type: 'string', enum: ['overwrite', 'append'] },
  },
  required: ['path', 'content'],
})

function descriptor(id: string, name: string): CapabilityDescriptor {
  return {
    version: 1,
    id,
    name,
    summary: `${name} 的方向性描述`,
    source: 'builtin',
    schemaRef: `${id}:schema`,
    access: 'write',
    dataClasses: ['workspace'],
    confirmation: 'on_demand',
    parallelSafe: false,
  }
}

const catalog = createCapabilityCatalog(
  Array.from({ length: 30 }, (_, index) => descriptor(`builtin:tool-${String(index + 1).padStart(2, '0')}`, `Tool${index + 1}`)),
)
const schemas = Object.fromEntries(catalog.descriptors.map((entry) => [entry.schemaRef, SCHEMA_BODY]))
const selectedIds = ['builtin:tool-03', 'builtin:tool-17']

function buildScoreboard(): CapabilityTokenScoreboard {
  return runCapabilityTokenBenchmark({ catalog, schemas, selectedIds })
}

describe('M4-04 capability catalog token regression', () => {
  test('baseline must include every schema while the optimized prompt carries only selected schemas', () => {
    const scoreboard = buildScoreboard()

    expect(scoreboard.benchmarkId).toBe('capability-catalog-token')
    expect(scoreboard.toolCount).toBe(30)
    expect(scoreboard.selectedCount).toBe(2)
    expect(scoreboard.optimizedTokens).toBeLessThan(scoreboard.baselineTokens)
    // 2/30 选中：节省率由 fixture 尺寸决定（此处 schema 较小，约 55%），只断言显著节省
    expect(scoreboard.savingsRate).toBeGreaterThan(0.3)
  })

  test('optimized estimate equals summary plus exactly the selected schema bodies', () => {
    const scoreboard = buildScoreboard()
    const projection = projectCapabilitySchemas({ catalog, selectedIds, resolveSchema: (schemaRef) => schemas[schemaRef] })
    const expected = estimateCapabilityTokens(
      [renderCapabilitySummary(catalog), ...projection.selected.map((entry) => schemas[entry.descriptor.schemaRef])].join('\n\n'),
    )

    expect(scoreboard.optimizedTokens).toBe(expected)
  })

  test('savings grow as fewer tools are selected', () => {
    const one = runCapabilityTokenBenchmark({ catalog, schemas, selectedIds: ['builtin:tool-01'] })
    const many = runCapabilityTokenBenchmark({ catalog, schemas, selectedIds: catalog.descriptors.map((entry) => entry.id) })

    expect(many.savingsRate).toBeLessThan(one.savingsRate)
    // 全选时 summary 与 baseline 中的描述重复，成为纯开销：节省率不优于 0。
    // 这正是两层目录的适用边界——只对“选中子集”有收益。
    expect(many.savingsRate).toBeLessThanOrEqual(0)
  })

  test('is deterministic for identical inputs', () => {
    expect(buildScoreboard()).toEqual(buildScoreboard())
  })
})
