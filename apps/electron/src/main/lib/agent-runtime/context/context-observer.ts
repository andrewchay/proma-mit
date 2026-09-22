import { join } from 'node:path'
import {
  ContextLedgerStore,
  recordArtifact,
  recordSessionMessage,
  recordToolObservation,
  type ArtifactInput,
  type SessionMessageInput,
  type ToolObservationInput,
} from './context-ledger'
import { ContextMetricsStore, type ContextCompilerMetricEvent } from './context-metrics'

const TYPED_CONTEXT_OBSERVABILITY_ENV = 'GRAVITAS_TYPED_CONTEXT_OBSERVABILITY'

export interface ContextLedgerObserver {
  recordSessionMessage(input: SessionMessageInput): void
  recordToolObservation(input: ToolObservationInput): void
  recordArtifact(input: ArtifactInput): void
  recordMetric(event: ContextCompilerMetricEvent): void
}

export interface CreateContextLedgerObserverOptions {
  workspaceDirectory?: string
  enabled?: boolean
  onError?: (error: unknown) => void
}

/**
 * M0 的旁路观测开关。默认关闭，且任何 ledger I/O 错误均不会影响 Agent 主流程。
 */
export function createContextLedgerObserver(
  options: CreateContextLedgerObserverOptions,
): ContextLedgerObserver | undefined {
  const enabled = options.enabled ?? process.env[TYPED_CONTEXT_OBSERVABILITY_ENV] === '1'
  if (!enabled || !options.workspaceDirectory) return undefined

  const contextDirectory = join(options.workspaceDirectory, 'context')
  const store = new ContextLedgerStore(contextDirectory)
  const metrics = new ContextMetricsStore(contextDirectory)
  const recordSafely = (operation: () => void): void => {
    try {
      operation()
    } catch (error) {
      options.onError?.(error)
    }
  }

  return {
    recordSessionMessage(input): void {
      recordSafely(() => { recordSessionMessage(store, input) })
    },
    recordToolObservation(input): void {
      recordSafely(() => { recordToolObservation(store, input) })
    },
    recordArtifact(input): void {
      recordSafely(() => { recordArtifact(store, input) })
    },
    recordMetric(event): void {
      recordSafely(() => { metrics.append(event) })
    },
  }
}

export { TYPED_CONTEXT_OBSERVABILITY_ENV }
