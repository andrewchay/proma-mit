/**
 * Shared utility functions for proma
 */

// Placeholder - will be expanded as needed
export function noop(): void {
  // no-op
}

export { diffCapabilities } from './capabilities-diff'
export type { CapabilityChange } from './capabilities-diff'
export {
  THINKING_SIGNATURE_ERROR_CODE,
  THINKING_SIGNATURE_ERROR_TITLE,
  THINKING_SIGNATURE_ERROR_MESSAGE,
  isThinkingSignatureError,
  formatThinkingSignatureError,
  normalizeThinkingSignatureError,
} from './thinking-signature-error'
export {
  getRuntimeErrorMessage,
  normalizeAgentRuntimeError,
} from './agent-runtime-error'
export type { NormalizeAgentRuntimeErrorInput } from './agent-runtime-error'
export {
  AgentRuntimeEventReplayHub,
  AgentRuntimeTaskRunner,
} from './agent-runtime-server'
export type {
  AgentRuntimeEventEmitInput,
  AgentRuntimeEventHubOptions,
  AgentRuntimeEventRecord,
  AgentRuntimeEventReplayInput,
  AgentRuntimeEventSubscribeInput,
  AgentRuntimeScope,
  AgentRuntimeTaskContext,
  AgentRuntimeTaskMeta,
  AgentRuntimeTaskStatus,
  ScopedAgentSession,
  StartAgentRuntimeTaskInput,
} from './agent-runtime-server'
export {
  AGENT_RUNTIME_POSTGRES_SCHEMA_SQL,
  PostgresTenantRuntimeStore,
} from './agent-runtime-postgres-store'
export type {
  AgentRuntimePostgresClient,
  AgentRuntimePostgresQueryResult,
} from './agent-runtime-postgres-store'
export {
  InMemoryTenantRuntimeStore,
  ServerMcpOAuthCallbackHandler,
} from './agent-runtime-tenant-store'
export type {
  HandleServerMcpOAuthCallbackResult,
  RegisteredServerMcpOAuth,
  RegisterServerMcpOAuthInput,
  ServerMcpOAuthPending,
  TenantMcpClientSecret,
  TenantMcpOAuthTokens,
  TenantRuntimeCredential,
  TenantRuntimeSecretEncoding,
  TenantRuntimeSession,
  TenantRuntimeStore,
  TenantRuntimeWorkspace,
} from './agent-runtime-tenant-store'
export {
  createAgentRuntimeWebServer,
  createBase64AgentRuntimeWebSecretCodec,
  createPlainAgentRuntimeWebSecretCodec,
} from './agent-runtime-web-server'
export type {
  AgentRuntimeWebAgentTurnInput,
  AgentRuntimeWebAgentTurnRunner,
  AgentRuntimeWebTaskPreflight,
  AgentRuntimeWebTaskPreflightInput,
  AgentRuntimeWebAuthResolver,
  AgentRuntimeWebAuthResolverInput,
  AgentRuntimeWebSecretCodec,
  AgentRuntimeWebSecretContext,
  AgentRuntimeWebServer,
  CreateAgentRuntimeWebServerOptions,
} from './agent-runtime-web-server'
export {
  createWebCryptoEnvelopeSecretCodec,
  parseWebCryptoEnvelopeKey,
} from './agent-runtime-web-secret-codec'
export type { WebCryptoEnvelopeSecretCodecOptions } from './agent-runtime-web-secret-codec'
export {
  RedisAgentRuntimeEventStore,
  RedisAgentRuntimeTaskCache,
} from './agent-runtime-redis-store'
export type {
  AgentRuntimeRedisClient,
  AgentRuntimeRedisSetOptions,
  AgentRuntimeRedisStreamEntry,
  RedisAgentRuntimeEventStoreOptions,
  RedisAgentRuntimeTaskCacheOptions,
} from './agent-runtime-redis-store'
export {
  createAgentRuntimeSessionArtifactObjectKey,
  createAgentRuntimeSessionArtifactObjectPrefix,
  createAgentRuntimeWorkspaceObjectKey,
  createAgentRuntimeWorkspaceObjectPrefix,
  InMemoryAgentRuntimeObjectStore,
  normalizeRelativeObjectPath,
} from './agent-runtime-object-storage'
export type {
  AgentRuntimeListObjectsInput,
  AgentRuntimeObjectRef,
  AgentRuntimeObjectStore,
  AgentRuntimePutObjectInput,
  AgentRuntimeSessionArtifactObjectInput,
  AgentRuntimeStoredObject,
  AgentRuntimeWorkspaceObjectInput,
} from './agent-runtime-object-storage'
export { InMemoryAgentRuntimeInteractionStore } from './agent-runtime-interaction-store'
export type {
  AgentRuntimeInteractionKind,
  AgentRuntimeInteractionRecord,
  AgentRuntimeInteractionRequest,
  AgentRuntimeInteractionResponse,
  AgentRuntimeInteractionStatus,
  AgentRuntimeInteractionStore,
  CreateAgentRuntimeInteractionInput,
  ListAgentRuntimeInteractionsInput,
} from './agent-runtime-interaction-store'
