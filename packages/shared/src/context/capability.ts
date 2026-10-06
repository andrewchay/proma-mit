export type CapabilitySource = 'builtin' | 'mcp' | 'workspace'
export type CapabilityAccess = 'read' | 'write' | 'external'
export type CapabilityConfirmation = 'never' | 'on_demand' | 'always'
export type CapabilityDataClass = 'public' | 'workspace' | 'user_content' | 'credential' | 'network'

/** M4-01 稳定能力层：不携带完整参数 schema，只描述选择和权限所需的元数据。 */
export interface CapabilityDescriptor {
  version: 1
  id: string
  name: string
  summary: string
  source: CapabilitySource
  /** 完整参数 schema 的稳定引用；M4-02/03 才按需解析。 */
  schemaRef: string
  access: CapabilityAccess
  dataClasses: CapabilityDataClass[]
  confirmation: CapabilityConfirmation
  parallelSafe: boolean
  toolName?: string
  serverName?: string
}

export interface CapabilityDescriptorValidation {
  valid: boolean
  reasons: string[]
}

export interface CapabilityCatalog {
  version: 1
  descriptors: CapabilityDescriptor[]
}

export function createCapabilityCatalog(descriptors: readonly CapabilityDescriptor[] = []): CapabilityCatalog {
  const catalog: CapabilityCatalog = { version: 1, descriptors: [] }
  for (const descriptor of descriptors) registerCapabilityDescriptor(catalog, descriptor)
  return catalog
}

/** 以稳定 id 去重；同 id 的新 descriptor 替换旧版本，避免 prompt 层出现歧义。 */
export function registerCapabilityDescriptor(catalog: CapabilityCatalog, descriptor: CapabilityDescriptor): void {
  const index = catalog.descriptors.findIndex((candidate) => candidate.id === descriptor.id)
  const copy = clone(descriptor)
  if (index < 0) catalog.descriptors.push(copy)
  else catalog.descriptors[index] = copy
}

export function getCapabilityDescriptor(catalog: CapabilityCatalog, id: string): CapabilityDescriptor | undefined {
  const descriptor = catalog.descriptors.find((candidate) => candidate.id === id)
  return descriptor ? clone(descriptor) : undefined
}

export function listCapabilityDescriptors(catalog: CapabilityCatalog): CapabilityDescriptor[] {
  return catalog.descriptors.map((descriptor) => clone(descriptor))
}


const SOURCES: ReadonlySet<CapabilitySource> = new Set(['builtin', 'mcp', 'workspace'])
const ACCESSES: ReadonlySet<CapabilityAccess> = new Set(['read', 'write', 'external'])
const CONFIRMATIONS: ReadonlySet<CapabilityConfirmation> = new Set(['never', 'on_demand', 'always'])
const DATA_CLASSES: ReadonlySet<CapabilityDataClass> = new Set(['public', 'workspace', 'user_content', 'credential', 'network'])

export function validateCapabilityDescriptor(value: unknown): CapabilityDescriptorValidation {
  const reasons: string[] = []
  if (!isRecord(value)) return { valid: false, reasons: ['descriptor must be an object'] }
  if (value.version !== 1) reasons.push('version must be 1')
  for (const field of ['id', 'name', 'summary', 'schemaRef']) {
    if (!isNonEmptyString(value[field])) reasons.push(`${field} must be a non-empty string`)
  }
  if (!SOURCES.has(value.source as CapabilitySource)) reasons.push('source is invalid')
  if (!ACCESSES.has(value.access as CapabilityAccess)) reasons.push('access is invalid')
  if (!CONFIRMATIONS.has(value.confirmation as CapabilityConfirmation)) reasons.push('confirmation is invalid')
  if (!Array.isArray(value.dataClasses) || value.dataClasses.length === 0 || value.dataClasses.some((item) => !DATA_CLASSES.has(item as CapabilityDataClass))) reasons.push('dataClasses must contain valid values')
  if (typeof value.parallelSafe !== 'boolean') reasons.push('parallelSafe must be boolean')
  if (value.source === 'mcp' && !isNonEmptyString(value.serverName)) reasons.push('mcp descriptor requires serverName')
  if (value.source !== 'mcp' && value.serverName !== undefined) reasons.push('serverName is only valid for mcp descriptors')
  if (value.toolName !== undefined && !isNonEmptyString(value.toolName)) reasons.push('toolName must be a non-empty string when provided')
  return { valid: reasons.length === 0, reasons }
}

export function parseCapabilityDescriptor(value: unknown): CapabilityDescriptor {
  const validation = validateCapabilityDescriptor(value)
  if (!validation.valid) throw new Error(`Invalid capability descriptor: ${validation.reasons.join('; ')}`)
  return clone(value as CapabilityDescriptor)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
