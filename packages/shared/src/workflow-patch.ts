/** Workflow 对话编辑使用的受限 patch 协议。 */

import { z } from 'zod'
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from './types/workflow'
import { parseWorkflowDefinition } from './workflow-schema'

const NodeSchema = z.object({
  id: z.string(), kind: z.enum(['start', 'end', 'agent', 'tool', 'skill', 'transform', 'condition', 'approval']), title: z.string(),
  description: z.string().optional(), config: z.record(z.string(), z.unknown()).optional(), capabilityPolicy: z.record(z.string(), z.unknown()).optional(),
  retry: z.object({ maxAttempts: z.number().int(), backoff: z.enum(['fixed', 'exponential']), initialDelayMs: z.number().int().optional(), maxDelayMs: z.number().int().optional() }).optional(),
  onFailure: z.enum(['fail', 'continue', 'route_to_error']).optional(),
})
const EdgeSchema = z.object({ id: z.string(), from: z.string(), to: z.string(), label: z.string().optional() })

export const WorkflowPatchSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_metadata'), name: z.string().min(1).max(120).optional(), description: z.string().max(2000).optional() }),
  z.object({ op: z.literal('set_trigger'), trigger: z.object({ kind: z.enum(['manual', 'schedule', 'event']), config: z.record(z.string(), z.unknown()).optional() }) }),
  z.object({ op: z.literal('add_node'), node: NodeSchema, position: z.object({ x: z.number(), y: z.number() }) }),
  z.object({ op: z.literal('update_node'), nodeId: z.string(), changes: NodeSchema.omit({ id: true }).partial() }),
  z.object({ op: z.literal('remove_node'), nodeId: z.string() }),
  z.object({ op: z.literal('add_edge'), edge: EdgeSchema }),
  z.object({ op: z.literal('remove_edge'), edgeId: z.string() }),
  z.object({ op: z.literal('move_node'), nodeId: z.string(), position: z.object({ x: z.number(), y: z.number() }) }),
])

export type WorkflowPatch = z.infer<typeof WorkflowPatchSchema>

export function applyWorkflowPatches(definition: WorkflowDefinition, patches: unknown[]): WorkflowDefinition {
  let next: WorkflowDefinition = JSON.parse(JSON.stringify(definition)) as WorkflowDefinition
  for (const rawPatch of patches) {
    const patch = WorkflowPatchSchema.parse(rawPatch)
    switch (patch.op) {
      case 'set_metadata':
        next = { ...next, ...(patch.name ? { name: patch.name } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}) }
        break
      case 'set_trigger':
        next = { ...next, trigger: patch.trigger }
        break
      case 'add_node':
        if (next.nodes.some((node) => node.id === patch.node.id)) throw new Error(`节点已存在: ${patch.node.id}`)
        next = { ...next, nodes: [...next.nodes, patch.node as unknown as WorkflowNode], layout: { ...next.layout, nodes: { ...next.layout.nodes, [patch.node.id]: patch.position } } }
        break
      case 'update_node':
        if (!next.nodes.some((node) => node.id === patch.nodeId)) throw new Error(`节点不存在: ${patch.nodeId}`)
        next = { ...next, nodes: next.nodes.map((node) => node.id === patch.nodeId ? { ...node, ...patch.changes } as WorkflowNode : node) }
        break
      case 'remove_node':
        if (next.nodes.find((node) => node.id === patch.nodeId)?.kind === 'start' || next.nodes.find((node) => node.id === patch.nodeId)?.kind === 'end') throw new Error('不能删除 start 或 end 节点')
        next = { ...next, nodes: next.nodes.filter((node) => node.id !== patch.nodeId), edges: next.edges.filter((edge) => edge.from !== patch.nodeId && edge.to !== patch.nodeId), layout: { ...next.layout, nodes: Object.fromEntries(Object.entries(next.layout.nodes).filter(([id]) => id !== patch.nodeId)) } }
        break
      case 'add_edge':
        if (next.edges.some((edge) => edge.id === patch.edge.id)) throw new Error(`连线已存在: ${patch.edge.id}`)
        next = { ...next, edges: [...next.edges, patch.edge as WorkflowEdge] }
        break
      case 'remove_edge':
        next = { ...next, edges: next.edges.filter((edge) => edge.id !== patch.edgeId) }
        break
      case 'move_node':
        next = { ...next, layout: { ...next.layout, nodes: { ...next.layout.nodes, [patch.nodeId]: patch.position } } }
        break
    }
  }
  return parseWorkflowDefinition({ ...next, updatedAt: Date.now() })
}
