import type { ContextItemKind, ContextVisibility } from './types'

export type ContextProjectionPurpose =
  | 'main_turn'
  | 'subagent_spawn'
  | 'tool_discovery'
  | 'compaction'
  | 'evaluation'

export type ContextRepresentation = 'summary' | 'full' | 'locator'

export interface ContextProjectionPolicy {
  allowUnverified: boolean
  includeRawEvidence: boolean
  includeSummaries: boolean
  includeFullContent: boolean
  allowedPaths?: string[]
  deniedPaths?: string[]
  allowedToolClasses?: string[]
  modelAllowlist?: string[]
}

export interface ContextProjectionRequest {
  sessionId: string
  purpose: ContextProjectionPurpose
  task: string
  targetAgentId?: string
  targetModel?: {
    provider: string
    modelId: string
  }
  maxInputTokens?: number
  requiredKinds?: ContextItemKind[]
  excludedKinds?: ContextItemKind[]
  allowedVisibility?: ContextVisibility[]
  policy?: ContextProjectionPolicy
}

export interface ContextProjectionItem {
  itemId: string
  representation: ContextRepresentation
  reason: string
  score?: number
}

export interface ContextProjectionOmission {
  itemId: string
  reason: string
}

export interface ContextProjection {
  id: string
  request: ContextProjectionRequest
  items: ContextProjectionItem[]
  renderedPromptBlocks: string[]
  renderedToolCatalog?: string
  omittedItemIds: string[]
  omissions: ContextProjectionOmission[]
  tokenEstimate: number
  createdAt: string
  sourceRevision: string
}
