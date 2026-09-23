import type { CapabilityCatalog, CapabilityDescriptor } from './capability'

/**
 * M4-02 常驻能力摘要。
 *
 * 只输出方向性描述（名称、用途、访问级别、数据类别、确认要求、并行安全性），
 * 绝不携带参数 schema 或 schemaRef 指向的正文；完整 schema 由 M4-03 按需投影。
 * 输出按 id 排序、与注册顺序无关，保证同一 catalog 产出 byte-stable 的 prompt 片段。
 */
export function renderCapabilitySummary(catalog: CapabilityCatalog): string {
  const lines = [`## 可用能力目录（${catalog.descriptors.length} 项）`, '', '以下为方向性描述；调用前按需加载完整参数 schema。', '']
  const sorted = [...catalog.descriptors].sort((a, b) => a.id.localeCompare(b.id))
  for (const descriptor of sorted) lines.push(renderCapabilitySummaryLine(descriptor))
  return lines.join('\n')
}

export function renderCapabilitySummaryLine(descriptor: CapabilityDescriptor): string {
  const scope = descriptor.source === 'mcp' ? `（MCP: ${descriptor.serverName}）` : ''
  const parallel = descriptor.parallelSafe ? '可并行' : '需串行'
  const data = descriptor.dataClasses.join('/')
  return `- [${descriptor.id}] ${descriptor.name}${scope} — ${descriptor.summary}（access=${descriptor.access}，data=${data}，confirm=${descriptor.confirmation}，${parallel}）`
}
