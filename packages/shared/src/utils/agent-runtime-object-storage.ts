import type { AgentRuntimeScope, ScopedAgentSession } from './agent-runtime-server'

export interface AgentRuntimeObjectRef {
  key: string
  size: number
  contentType?: string
  updatedAt: number
}

export interface AgentRuntimePutObjectInput {
  key: string
  body: Uint8Array
  contentType?: string
}

export interface AgentRuntimeStoredObject extends AgentRuntimeObjectRef {
  body: Uint8Array
}

export interface AgentRuntimeListObjectsInput {
  prefix: string
  limit?: number
}

export interface AgentRuntimeObjectStore {
  putObject(input: AgentRuntimePutObjectInput): Promise<AgentRuntimeObjectRef>
  getObject(key: string): Promise<AgentRuntimeStoredObject | undefined>
  deleteObject(key: string): Promise<void>
  listObjects(input: AgentRuntimeListObjectsInput): Promise<AgentRuntimeObjectRef[]>
}

export interface AgentRuntimeWorkspaceObjectInput extends AgentRuntimeScope {
  workspaceSlug: string
  relativePath: string
}

export interface AgentRuntimeSessionArtifactObjectInput extends ScopedAgentSession {
  relativePath: string
}

export class InMemoryAgentRuntimeObjectStore implements AgentRuntimeObjectStore {
  private readonly objects = new Map<string, AgentRuntimeStoredObject>()

  async putObject(input: AgentRuntimePutObjectInput): Promise<AgentRuntimeObjectRef> {
    const stored: AgentRuntimeStoredObject = {
      key: input.key,
      body: cloneBytes(input.body),
      size: input.body.byteLength,
      contentType: input.contentType,
      updatedAt: Date.now(),
    }
    this.objects.set(input.key, stored)
    return objectRef(stored)
  }

  async getObject(key: string): Promise<AgentRuntimeStoredObject | undefined> {
    const object = this.objects.get(key)
    return object ? { ...objectRef(object), body: cloneBytes(object.body) } : undefined
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async listObjects(input: AgentRuntimeListObjectsInput): Promise<AgentRuntimeObjectRef[]> {
    return [...this.objects.values()]
      .filter((object) => object.key.startsWith(input.prefix))
      .sort((left, right) => left.key.localeCompare(right.key))
      .slice(0, input.limit)
      .map(objectRef)
  }
}

export function createAgentRuntimeWorkspaceObjectPrefix(
  scope: AgentRuntimeScope,
  workspaceSlug: string,
): string {
  return [
    'tenants',
    encodeObjectKeyPart(scope.tenantId),
    'users',
    encodeObjectKeyPart(scope.userId),
    'workspaces',
    encodeObjectKeyPart(workspaceSlug),
    'files',
  ].join('/')
}

export function createAgentRuntimeWorkspaceObjectKey(input: AgentRuntimeWorkspaceObjectInput): string {
  return `${createAgentRuntimeWorkspaceObjectPrefix(input, input.workspaceSlug)}/${normalizeRelativeObjectPath(input.relativePath)}`
}

export function createAgentRuntimeSessionArtifactObjectPrefix(input: ScopedAgentSession): string {
  return [
    'tenants',
    encodeObjectKeyPart(input.tenantId),
    'users',
    encodeObjectKeyPart(input.userId),
    'sessions',
    encodeObjectKeyPart(input.sessionId),
    'artifacts',
  ].join('/')
}

export function createAgentRuntimeSessionArtifactObjectKey(input: AgentRuntimeSessionArtifactObjectInput): string {
  return `${createAgentRuntimeSessionArtifactObjectPrefix(input)}/${normalizeRelativeObjectPath(input.relativePath)}`
}

export function normalizeRelativeObjectPath(relativePath: string): string {
  if (!relativePath.trim()) {
    throw new Error('对象路径不能为空')
  }
  const normalized = relativePath.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error('对象路径必须是相对路径')
  }
  const parts = normalized.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('对象路径不能包含空段、. 或 ..')
  }
  return parts.map(encodeObjectKeyPart).join('/')
}

function objectRef(object: AgentRuntimeStoredObject): AgentRuntimeObjectRef {
  return {
    key: object.key,
    size: object.size,
    contentType: object.contentType,
    updatedAt: object.updatedAt,
  }
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  const cloned = new Uint8Array(bytes.byteLength)
  cloned.set(bytes)
  return cloned
}

function encodeObjectKeyPart(value: string): string {
  if (!value.trim()) {
    throw new Error('对象 key 段不能为空')
  }
  return encodeURIComponent(value)
}
