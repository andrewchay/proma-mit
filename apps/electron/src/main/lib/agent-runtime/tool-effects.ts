import type { CapabilityDescriptor, ToolEffects } from '@gravitas/shared'
import { isIndependentReadCandidate, isToolEffectsDataRecord, normalizeToolEffects, unknownToolEffects, validateCapabilityDescriptor } from '@gravitas/shared'
import type { RuntimeToolDefinition } from './types'
import { READ_TOOL_NAME, executeReadTool } from './tool-impls/read-tool'
import { WRITE_TOOL_NAME, executeWriteTool } from './tool-impls/write-tool'
import { EDIT_TOOL_NAME, executeEditTool } from './tool-impls/edit-tool'

interface EffectBinding {
  name: string
  execute: RuntimeToolDefinition['execute']
  effects: ToolEffects
}
export interface CapabilityToolEffectsAssessment {
  effects: ToolEffects
  independentReadCandidate: boolean
}
// 仅给既有工具实例附来源，不建立另一套工具目录，也不通过DTO鉴权。
const bindings = new WeakMap<RuntimeToolDefinition, EffectBinding>()
function ownValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

/** 只匹配已编译的三个执行入口，不接受调用者自述的effects。 */
export function bindCoreToolEffects(tool: RuntimeToolDefinition): RuntimeToolDefinition {
  const name = ownValue(tool, 'name')
  const execute = ownValue(tool, 'execute')
  const read = name === READ_TOOL_NAME && execute === executeReadTool
  const write = name === WRITE_TOOL_NAME && execute === executeWriteTool
  const edit = name === EDIT_TOOL_NAME && execute === executeEditTool
  if (!read && !write && !edit) return tool
  const resources = Object.freeze([Object.freeze({
    kind: 'filesystem' as const, mode: read ? 'read' as const : 'write' as const,
    pathParameter: 'file_path', scope: write ? 'path-and-ancestors' as const : 'path' as const,
  })])
  const effects: ToolEffects = Object.freeze({ version: 1, resources, replay: read ? 'idempotent_read' : 'never' })
  tool.effects = effects
  bindings.set(tool, { name: tool.name, execute: tool.execute, effects })
  return tool
}
export function getRegisteredToolEffects(tool: RuntimeToolDefinition): ToolEffects {
  const binding = bindings.get(tool)
  if (!binding || ownValue(tool, 'name') !== binding.name || ownValue(tool, 'execute') !== binding.execute ||
    ownValue(tool, 'effects') !== binding.effects) return unknownToolEffects()
  return normalizeToolEffects(binding.effects)
}

/** catalog是方向提示；实际执行对象的声明才是来源，仍不授予执行权限。 */
export function assessCapabilityToolEffects(descriptor: CapabilityDescriptor, tool: RuntimeToolDefinition): CapabilityToolEffectsAssessment {
  const unknown = (): CapabilityToolEffectsAssessment => ({ effects: unknownToolEffects(), independentReadCandidate: false })
  if (!isToolEffectsDataRecord(descriptor)) return unknown()
  const classes: unknown = descriptor.dataClasses
  if (!Array.isArray(classes) || Object.getPrototypeOf(classes) !== Array.prototype ||
    Reflect.ownKeys(classes).length !== classes.length + 1) return unknown()
  for (let i = 0; i < classes.length; i++) {
    if (typeof ownValue(classes, String(i)) !== 'string') return unknown()
  }
  if (!validateCapabilityDescriptor(descriptor).valid || descriptor.source !== 'builtin' ||
    descriptor.toolName !== ownValue(tool, 'name')) return unknown()
  const effects = getRegisteredToolEffects(tool)
  if (effects.resources.some((r) => r.kind !== 'filesystem' || r.mode !== descriptor.access)) return unknown()
  return { effects, independentReadCandidate: descriptor.parallelSafe && isIndependentReadCandidate(effects) }
}
