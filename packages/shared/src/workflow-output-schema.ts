/** Workflow 节点 outputSchema 的最小 JSON Schema 校验器。仅支持可预测、可审计的子集。 */

export interface WorkflowOutputValidationResult {
  valid: boolean
  errors: string[]
}

function validate(value: unknown, schema: Record<string, unknown>, path: string, errors: string[]): void {
  const type = schema.type
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${path} 必须是对象`); return }
    const record = value as Record<string, unknown>
    const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []
    for (const key of required) if (!(key in record)) errors.push(`${path}.${key} 为必填字段`)
    const properties = schema.properties
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        if (key in record && child && typeof child === 'object' && !Array.isArray(child)) validate(record[key], child as Record<string, unknown>, `${path}.${key}`, errors)
      }
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) { errors.push(`${path} 必须是数组`); return }
    const items = schema.items
    if (items && typeof items === 'object' && !Array.isArray(items)) value.forEach((item, index) => validate(item, items as Record<string, unknown>, `${path}[${index}]`, errors))
  } else if (type === 'string' && typeof value !== 'string') errors.push(`${path} 必须是字符串`)
  else if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) errors.push(`${path} 必须是数字`)
  else if (type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) errors.push(`${path} 必须是整数`)
  else if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${path} 必须是布尔值`)
  else if (type === 'null' && value !== null) errors.push(`${path} 必须是 null`)
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) errors.push(`${path} 不在允许的 enum 中`)
}

export function validateWorkflowOutput(value: unknown, schema: Record<string, unknown>): WorkflowOutputValidationResult {
  const errors: string[] = []
  validate(value, schema, '$', errors)
  return { valid: errors.length === 0, errors }
}
