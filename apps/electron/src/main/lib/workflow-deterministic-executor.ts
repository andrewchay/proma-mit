/** 无副作用的 Workflow 变换与条件节点执行器，禁止使用 eval/new Function。 */

import type { WorkflowRun } from '@proma/shared'
import { completeWorkflowNode, failWorkflowNode, getWorkflowRun, startWorkflowNode } from './workflow-service'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function nodeById(run: WorkflowRun, nodeId: string) {
  const node = run.snapshot.definition.nodes.find((item) => item.id === nodeId)
  if (!node) throw new Error(`Workflow 节点不存在: ${nodeId}`)
  return node
}

function contextOf(run: WorkflowRun): Record<string, unknown> {
  return {
    input: run.input,
    nodes: Object.fromEntries(Object.entries(run.nodeRuns).map(([id, nodeRun]) => [id, { output: nodeRun.output ?? {}, status: nodeRun.status }])),
  }
}

function resolvePath(context: Record<string, unknown>, reference: string): unknown {
  const path = reference.replace(/^\$/, '').split('.')
  let current: unknown = context
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !(part in current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function resolveTemplate(value: unknown, context: Record<string, unknown>): JsonValue {
  if (typeof value === 'string') return value.startsWith('$') ? (resolvePath(context, value) as JsonValue ?? null) : value
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(item, context))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplate(item, context)]))
  throw new Error('transform assignments 只支持 JSON 值或 $ 路径引用')
}

function parseLiteral(source: string, context: Record<string, unknown>): JsonValue {
  const trimmed = source.trim()
  if (trimmed.startsWith('$')) return (resolvePath(context, trimmed) as JsonValue ?? null)
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  const quoted = trimmed.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/)
  if (quoted) return quoted[1] ?? quoted[2] ?? ''
  throw new Error(`条件表达式包含不支持的值: ${trimmed}`)
}

function evaluateCondition(expression: string, context: Record<string, unknown>): boolean {
  const match = expression.trim().match(/^(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/)
  if (!match) throw new Error('condition 仅支持两个值的 ===、!==、==、!=、>=、<=、>、< 比较')
  const left = parseLiteral(match[1]!, context)
  const right = parseLiteral(match[3]!, context)
  switch (match[2]) {
    case '===': return left === right
    case '!==': return left !== right
    case '==': return String(left) === String(right)
    case '!=': return String(left) !== String(right)
    case '>': return typeof left === 'number' && typeof right === 'number' && left > right
    case '>=': return typeof left === 'number' && typeof right === 'number' && left >= right
    case '<': return typeof left === 'number' && typeof right === 'number' && left < right
    case '<=': return typeof left === 'number' && typeof right === 'number' && left <= right
    default: throw new Error('不支持的条件操作符')
  }
}

/** 执行 transform 或 condition；失败会记录审计状态，不抛出未记录的异常。 */
export function executeWorkflowDeterministicNode(workflowId: string, runId: string, nodeId: string): WorkflowRun {
  const run = getWorkflowRun(workflowId, runId)
  if (!run) throw new Error(`Workflow Run 不存在: ${runId}`)
  const node = nodeById(run, nodeId)
  if (node.kind !== 'transform' && node.kind !== 'condition') throw new Error('当前节点不是 transform 或 condition 节点')
  startWorkflowNode(workflowId, runId, nodeId)
  try {
    const context = contextOf(run)
    if (node.kind === 'transform') {
      const assignments = (node.config as { assignments: Record<string, unknown> }).assignments
      return completeWorkflowNode(workflowId, runId, nodeId, resolveTemplate(assignments, context) as Record<string, unknown>)
    }
    const expression = (node.config as { expression: string }).expression
    const result = evaluateCondition(expression, context)
    const selected = run.snapshot.definition.edges.filter((edge) => edge.from === nodeId && edge.label?.toLowerCase() === String(result)).map((edge) => edge.to)
    if (selected.length === 0) throw new Error(`condition 节点缺少 ${String(result)} 分支`)
    return completeWorkflowNode(workflowId, runId, nodeId, { result }, { selectedOutgoingNodeIds: selected })
  } catch (error) {
    const message = error instanceof Error ? error.message : '确定性节点执行失败'
    return failWorkflowNode(workflowId, runId, nodeId, { code: 'deterministic_execution_failed', message, retryable: false })
  }
}
