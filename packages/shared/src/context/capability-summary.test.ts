import { describe, expect, test } from 'bun:test'
import type { CapabilityDescriptor } from './capability'
import { createCapabilityCatalog } from './capability'
import { renderCapabilitySummary } from './capability-summary'

function descriptor(overrides: Partial<CapabilityDescriptor> & Pick<CapabilityDescriptor, 'id' | 'name'>): CapabilityDescriptor {
  return {
    version: 1,
    summary: `${overrides.name} 的方向性描述`,
    source: 'builtin',
    schemaRef: `${overrides.id}:schema`,
    access: 'read',
    dataClasses: ['workspace'],
    confirmation: 'never',
    parallelSafe: true,
    ...overrides,
  }
}

const catalog = createCapabilityCatalog([
  descriptor({ id: 'builtin:zeta', name: 'Zeta' }),
  descriptor({
    id: 'mcp:alpha',
    name: 'Alpha',
    source: 'mcp',
    serverName: 'github',
    access: 'write',
    dataClasses: ['user_content', 'network'],
    confirmation: 'always',
    parallelSafe: false,
  }),
  descriptor({ id: 'workspace:beta', name: 'Beta', source: 'workspace', confirmation: 'on_demand' }),
])

const GOLDEN = `## 可用能力目录（3 项）

以下为方向性描述；调用前按需加载完整参数 schema。

- [builtin:zeta] Zeta — Zeta 的方向性描述（access=read，data=workspace，confirm=never，可并行）
- [mcp:alpha] Alpha（MCP: github） — Alpha 的方向性描述（access=write，data=user_content/network，confirm=always，需串行）
- [workspace:beta] Beta — Beta 的方向性描述（access=read，data=workspace，confirm=on_demand，可并行）`

describe('M4-02 capability summary catalog', () => {
  test('renders a byte-stable summary independent of registration order', () => {
    expect(renderCapabilitySummary(catalog)).toBe(GOLDEN)
    const reordered = createCapabilityCatalog([...catalog.descriptors].reverse())
    expect(renderCapabilitySummary(reordered)).toBe(GOLDEN)
  })

  test('never leaks parameter schemas or schema bodies into the summary', () => {
    const withSchemaText = createCapabilityCatalog([
      descriptor({
        id: 'builtin:schema-heavy',
        name: 'SchemaHeavy',
        summary: '这个工具的 summary 本身不含 schema',
      }),
    ])
    const rendered = renderCapabilitySummary(withSchemaText)
    expect(rendered).not.toContain('"type": "object"')
    expect(rendered).not.toContain('properties')
    expect(rendered).not.toContain(withSchemaText.descriptors[0]!.schemaRef)
  })

  test('empty catalog renders a valid empty block', () => {
    expect(renderCapabilitySummary(createCapabilityCatalog())).toBe(
      '## 可用能力目录（0 项）\n\n以下为方向性描述；调用前按需加载完整参数 schema。\n',
    )
  })
})
