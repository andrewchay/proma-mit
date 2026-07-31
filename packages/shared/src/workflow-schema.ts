import { z } from 'zod'
import {
  WORKFLOW_FORMAT,
  WORKFLOW_NODE_KINDS,
  type WorkflowDefinition,
} from './types/workflow'

const jsonObjectSchema = z.record(z.string(), z.unknown())
const workflowIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).max(160)
const scheduleTriggerConfigSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['interval', 'daily', 'weekly', 'monthly']),
  interval: z.number().int().min(1).max(10_080).optional(),
  intervalUnit: z.enum(['minutes', 'hours']).optional(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  channelId: z.string().min(1).max(160),
  modelId: z.string().min(1).max(160).optional(),
  input: jsonObjectSchema.optional(),
  concurrencyPolicy: z.enum(['forbid', 'allow']).optional(),
}).strict().superRefine((config, ctx) => {
  if (config.mode === 'interval' && config.interval === undefined) ctx.addIssue({ code: 'custom', path: ['interval'], message: 'interval 定时触发必须提供 interval' })
})
const eventTriggerConfigSchema = z.object({
  eventName: z.string().min(1).max(160),
  channelId: z.string().min(1).max(160),
  modelId: z.string().min(1).max(160).optional(),
  concurrencyPolicy: z.enum(['forbid', 'allow']).optional(),
}).strict()

const capabilityPolicySchema = z.object({
  skills: z.array(z.object({ slug: z.string().min(1), version: z.string().min(1).optional() })).optional(),
  mcpServers: z.array(z.object({ name: z.string().min(1), configFingerprint: z.string().min(1).optional() })).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  permissionProfileId: z.string().min(1).optional(),
}).strict()

const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(0).max(10),
  backoff: z.enum(['fixed', 'exponential']),
  initialDelayMs: z.number().int().min(0).optional(),
  maxDelayMs: z.number().int().min(0).optional(),
}).strict()

const workflowNodeSchema = z.object({
  id: workflowIdSchema,
  kind: z.enum(WORKFLOW_NODE_KINDS),
  title: z.string().min(1).max(240),
  description: z.string().max(4_000).optional(),
  config: z.unknown().optional(),
  capabilityPolicy: capabilityPolicySchema.optional(),
  retry: retryPolicySchema.optional(),
  onFailure: z.enum(['fail', 'continue', 'route_to_error']).optional(),
}).strict()

const workflowEdgeSchema = z.object({
  id: workflowIdSchema,
  from: z.string().min(1).max(160),
  to: z.string().min(1).max(160),
  label: z.string().min(1).max(160).optional(),
}).strict()

const sensitiveKeyPattern = /^(api[_-]?key|token|secret|password|authorization|cookie)$/i
const sensitiveValuePattern = /(?:^|\s)(?:bearer\s+|sk-[a-z0-9_-]{8,}|akia[a-z0-9]{12,})/i

/**
 * 检查 Definition 中是否误写入凭证。
 * 真正的密钥只能存在于工作区 MCP/渠道配置，由节点通过名称引用。
 */
function findSensitiveValue(value: unknown, path: Array<string | number> = []): string | null {
  if (typeof value === 'string') {
    return sensitiveValuePattern.test(value) ? path.join('.') : null
  }
  if (!value || typeof value !== 'object') return null

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findSensitiveValue(value[index], [...path, index])
      if (found) return found
    }
    return null
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveKeyPattern.test(key)) return [...path, key].join('.')
    const found = findSensitiveValue(child, [...path, key])
    if (found) return found
  }
  return null
}

function validateNodeConfig(node: z.infer<typeof workflowNodeSchema>, addIssue: (message: string) => void): void {
  if (node.kind === 'start' || node.kind === 'end') {
    if (node.config !== undefined || node.capabilityPolicy !== undefined || node.retry !== undefined) {
      addIssue(`${node.kind} 节点不能配置执行能力、重试或 config`)
    }
    return
  }

  if (!node.config || typeof node.config !== 'object' || Array.isArray(node.config)) {
    addIssue(`${node.kind} 节点必须提供对象形式的 config`)
    return
  }

  const config = node.config as Record<string, unknown>
  if (node.kind === 'agent' && (typeof config.prompt !== 'string' || !config.prompt.trim())) {
    addIssue('agent 节点必须提供非空 prompt')
  }
  if (node.kind === 'tool' && (typeof config.toolName !== 'string' || !config.toolName.trim())) {
    addIssue('tool 节点必须提供 toolName')
  }
  if (node.kind === 'skill') {
    const skill = config.skill
    if (!skill || typeof skill !== 'object' || Array.isArray(skill) || typeof (skill as Record<string, unknown>).slug !== 'string') {
      addIssue('skill 节点必须提供 skill.slug')
    }
    if (typeof config.prompt !== 'string' || !config.prompt.trim()) addIssue('skill 节点必须提供非空 prompt')
  }
  if (node.kind === 'transform' && (!config.assignments || typeof config.assignments !== 'object' || Array.isArray(config.assignments))) {
    addIssue('transform 节点必须提供 assignments 对象')
  }
  if (node.kind === 'condition' && (typeof config.expression !== 'string' || !config.expression.trim())) {
    addIssue('condition 节点必须提供非空 expression')
  }
  if (node.kind === 'approval') {
    if (!['workflow_owner', 'named_users', 'role'].includes(String(config.assigneePolicy))) {
      addIssue('approval 节点必须提供有效的 assigneePolicy')
    }
    if (!['fail', 'continue', 'route_to_error'].includes(String(config.onTimeout))) {
      addIssue('approval 节点必须提供有效的 onTimeout 策略')
    }
  }
}

function hasCycle(nodes: string[], edges: z.infer<typeof workflowEdgeSchema>[]): boolean {
  const outgoing = new Map(nodes.map((id) => [id, [] as string[]]))
  for (const edge of edges) outgoing.get(edge.from)?.push(edge.to)

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const next of outgoing.get(id) ?? []) {
      if (visit(next)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }

  return nodes.some(visit)
}

/** PAA Workflow DSL v1 的运行时校验器。 */
export const WorkflowDefinitionSchema = z.object({
  format: z.literal(WORKFLOW_FORMAT),
  formatVersion: z.literal('1.0'),
  id: z.string().min(1).max(160),
  workspaceId: z.string().min(1).max(160),
  teamId: z.string().min(1).max(160).default('personal'),
  name: z.string().min(1).max(240),
  description: z.string().max(4_000).optional(),
  status: z.enum(['draft', 'published', 'archived']),
  version: z.string().min(1).max(64),
  trigger: z.object({
    kind: z.enum(['manual', 'schedule', 'event']),
    config: jsonObjectSchema.optional(),
  }).strict(),
  inputSchema: jsonObjectSchema.optional(),
  nodes: z.array(workflowNodeSchema).min(2).max(200),
  edges: z.array(workflowEdgeSchema).max(400),
  layout: z.object({
    nodes: z.record(z.string(), z.object({ x: z.number().finite(), y: z.number().finite() }).strict()),
    viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().positive() }).strict().optional(),
  }).strict(),
  publication: z.object({
    version: z.string().min(1).max(64),
    publishedAt: z.number().int().nonnegative(),
    publishedBy: z.string().min(1).optional(),
    changeSummary: z.string().max(2_000).optional(),
  }).strict().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((definition, ctx) => {
  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()
  const starts = definition.nodes.filter((node) => node.kind === 'start')
  const ends = definition.nodes.filter((node) => node.kind === 'end')

  for (const [index, node] of definition.nodes.entries()) {
    if (nodeIds.has(node.id)) {
      ctx.addIssue({ code: 'custom', path: ['nodes', index, 'id'], message: `节点 ID 重复: ${node.id}` })
    }
    nodeIds.add(node.id)
    validateNodeConfig(node, (message) => {
      ctx.addIssue({ code: 'custom', path: ['nodes', index, 'config'], message })
    })
  }

  if (starts.length !== 1) ctx.addIssue({ code: 'custom', path: ['nodes'], message: '工作流必须且只能有一个 start 节点' })
  if (ends.length !== 1) ctx.addIssue({ code: 'custom', path: ['nodes'], message: '工作流必须且只能有一个 end 节点' })

  for (const [index, edge] of definition.edges.entries()) {
    if (edgeIds.has(edge.id)) ctx.addIssue({ code: 'custom', path: ['edges', index, 'id'], message: `连线 ID 重复: ${edge.id}` })
    edgeIds.add(edge.id)
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      ctx.addIssue({ code: 'custom', path: ['edges', index], message: '连线必须引用存在的节点' })
    }
    if (edge.from === edge.to) ctx.addIssue({ code: 'custom', path: ['edges', index], message: '节点不能连接到自身' })
  }

  const startId = starts[0]?.id
  const endId = ends[0]?.id
  if (startId && definition.edges.some((edge) => edge.to === startId)) {
    ctx.addIssue({ code: 'custom', path: ['edges'], message: 'start 节点不能有入边' })
  }
  if (endId && definition.edges.some((edge) => edge.from === endId)) {
    ctx.addIssue({ code: 'custom', path: ['edges'], message: 'end 节点不能有出边' })
  }
  if (hasCycle([...nodeIds], definition.edges)) {
    ctx.addIssue({ code: 'custom', path: ['edges'], message: 'Workflow DSL v1 仅支持无环 DAG' })
  }

  if (definition.trigger.kind === 'schedule') {
    const result = scheduleTriggerConfigSchema.safeParse(definition.trigger.config)
    if (!result.success) {
      for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', path: ['trigger', 'config', ...issue.path], message: issue.message })
    }
  }
  if (definition.trigger.kind === 'event') {
    const result = eventTriggerConfigSchema.safeParse(definition.trigger.config)
    if (!result.success) {
      for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', path: ['trigger', 'config', ...issue.path], message: issue.message })
    }
  }

  for (const node of definition.nodes.filter((item) => item.kind === 'condition')) {
    const labels = new Set(definition.edges.filter((edge) => edge.from === node.id).map((edge) => edge.label?.toLowerCase()))
    if (!labels.has('true') || !labels.has('false')) {
      ctx.addIssue({ code: 'custom', path: ['edges'], message: `condition 节点 ${node.id} 必须各有一条 label 为 true 和 false 的出边` })
    }
  }

  for (const node of definition.nodes.filter((item) => item.onFailure === 'route_to_error')) {
    const hasErrorRoute = definition.edges.some((edge) => edge.from === node.id && edge.label?.toLowerCase() === 'error')
    if (!hasErrorRoute) {
      ctx.addIssue({ code: 'custom', path: ['edges'], message: `节点 ${node.id} 使用 route_to_error 时必须有一条 label 为 error 的出边` })
    }
  }

  const sensitivePath = findSensitiveValue(definition)
  if (sensitivePath) {
    ctx.addIssue({ code: 'custom', path: sensitivePath.split('.'), message: 'Workflow Definition 不得存储凭证或授权头，请改用工作区能力引用' })
  }
})

/** 解析并返回已验证的 Workflow Definition。 */
export function parseWorkflowDefinition(input: unknown): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse(input) as WorkflowDefinition
}

/** 以不抛异常的方式校验来自聊天、文件导入或 IPC 的流程草案。 */
export function validateWorkflowDefinition(input: unknown): z.ZodSafeParseResult<WorkflowDefinition> {
  return WorkflowDefinitionSchema.safeParse(input) as z.ZodSafeParseResult<WorkflowDefinition>
}
