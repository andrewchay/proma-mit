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
  AgentRuntimeRole,
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
  TenantRuntimePermissionDecision,
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
  AgentRuntimeMcpToolDefinition,
  AgentRuntimeIsolatedExecutionRequest,
  AgentRuntimeIsolatedExecutionResult,
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
  createRotatingWebCryptoEnvelopeSecretCodec,
  parseWebCryptoEnvelopeKey,
  reencryptWebCryptoEnvelopeSecret,
} from './agent-runtime-web-secret-codec'
export type { RotatingWebCryptoEnvelopeSecretCodecOptions, WebCryptoEnvelopeSecretCodecOptions } from './agent-runtime-web-secret-codec'
export { createCloudKmsEnvelopeSecretCodec } from './agent-runtime-cloud-kms-secret-codec'
export type { CloudKmsDataKeyProvider, CloudKmsEnvelopeSecretCodecOptions } from './agent-runtime-cloud-kms-secret-codec'
export { validateServerMcpConfig } from './agent-runtime-server-mcp-policy'
export type { ServerMcpEgressPolicy, ValidatedServerMcpConfig } from './agent-runtime-server-mcp-policy'
export { ServerMcpConnectionManager } from './agent-runtime-server-mcp-manager'
export type { AcquireServerMcpConnectionInput, ServerMcpConnection, ServerMcpConnectionFactory, ServerMcpConnectionFactoryInput } from './agent-runtime-server-mcp-manager'
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
  ResolveAgentRuntimeInteractionInput,
} from './agent-runtime-interaction-store'
