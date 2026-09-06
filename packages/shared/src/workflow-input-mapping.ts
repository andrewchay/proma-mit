/** Workflow 节点输入映射：只解析受限 JSON 与已验证的变量引用，不执行表达式。 */

import type { WorkflowDefinition, WorkflowNode } from './types/workflow'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface WorkflowDataflowContext {
  input: Record<string, unknown>
  nodes: Record<string, { output?: unknown; status: string }>
}

export interface WorkflowDataflowViolation {
  nodeId: string
  path: string
  message: string
}

function getReferenceParts(reference: string): string[] {
  return reference.replace(/^\$/, '').split('.').filter(Boolean)
}

function resolveReference(reference: string, context: WorkflowDataflowContext): unknown {
  const parts = getReferenceParts(reference)
  let current: unknown = context
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !(part in current)) {
      throw new Error(`输入映射引用不存在: ${reference}`)
    }
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function resolveValue(value: unknown, context: WorkflowDataflowContext): JsonValue {
  if (typeof value === 'string') return value.startsWith('$') ? resolveReference(value, context) as JsonValue : value
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, context))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, context)]))
  throw new Error('输入映射只支持 JSON 值或 $ 变量引用')
}

/** 在执行前解析节点映射；未配置时保留整个 Workflow 输入以兼容既有定义。 */
export function resolveWorkflowNodeInput(mapping: Record<string, unknown> | undefined, context: WorkflowDataflowContext): Record<string, JsonValue> {
  return resolveValue(mapping ?? context.input, context) as Record<string, JsonValue>
}

function mappingOf(node: WorkflowNode): Record<string, unknown> | undefined {
  if (node.kind !== 'agent' && node.kind !== 'skill' && node.kind !== 'tool') return undefined
  const mapping = (node.config as { inputMapping?: unknown } | undefined)?.inputMapping
  return mapping && typeof mapping === 'object' && !Array.isArray(mapping) ? mapping as Record<string, unknown> : undefined
}

function collectReferences(value: unknown, path: string, references: Array<{ path: string; value: string }>): void {
  if (typeof value === 'string' && value.startsWith('$')) {
    references.push({ path, value })
    return
  }
  if (Array.isArray(value)) value.forEach((item, index) => collectReferences(item, `${path}[${index}]`, references))
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => collectReferences(item, `${path}.${key}`, references))
}

function ancestorIds(definition: WorkflowDefinition, nodeId: string): Set<string> {
  const parentsByNode = new Map(definition.nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of definition.edges) parentsByNode.get(edge.to)?.push(edge.from)
  const visited = new Set<string>()
  const pending = [...(parentsByNode.get(nodeId) ?? [])]
  while (pending.length > 0) {
    const parentId = pending.pop()!
    if (visited.has(parentId)) continue
    visited.add(parentId)
    pending.push(...(parentsByNode.get(parentId) ?? []))
  }
  return visited
}

/** 发布前校验：节点只能消费 Workflow 输入或其上游节点的已声明输出。 */
export function validateWorkflowDataflow(definition: WorkflowDefinition): WorkflowDataflowViolation[] {
  const violations: WorkflowDataflowViolation[] = []
  for (const node of definition.nodes) {
    const mapping = mappingOf(node)
    if (!mapping) continue
    const ancestors = ancestorIds(definition, node.id)
    const references: Array<{ path: string; value: string }> = []
    collectReferences(mapping, 'inputMapping', references)
    for (const reference of references) {
      const parts = getReferenceParts(reference.value)
      if (parts[0] === 'input') continue
      if (parts[0] !== 'nodes' || !parts[1] || parts[2] !== 'output') {
        violations.push({ nodeId: node.id, path: reference.path, message: `只支持 $input 或 $nodes.<上游节点>.output 引用: ${reference.value}` })
      } else if (!ancestors.has(parts[1])) {
        violations.push({ nodeId: node.id, path: reference.path, message: `不能引用非上游节点 ${parts[1]} 的输出` })
      }
    }
  }
  return violations
}
