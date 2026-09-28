import { randomUUID } from 'node:crypto'
import { derivePilotRequestEnvelope, getPilotReviewedPriceEvidence } from './project-pilot-request-evidence'
import { getAgentExecutionBySessionId } from './project-sqlite-store'
import { reservePilotRequest, verifyPilotRequestBody } from './project-pilot-request-reservation'

/**
 * Pilot 受控请求出口：每次模型 HTTP 请求必须依次通过
 * derive（最终 body 派生包络，fail-closed）→ reserve（命令预留内原子子预留）→
 * verify（发送前指纹核验）→ 真实 fetch。任一步失败即 throw，HTTP 零发送。
 * 仅 Pilot 受控执行注入；普通会话不经过此出口，行为不变。
 */

/** 当前唯一入库的真实价格证据；渠道模型必须与其 model 完全一致，否则 derive 拒发。 */
export const PILOT_DEFAULT_PRICE_EVIDENCE_ID = 'zai-glm-5.3-flash-2026-09-28'

export interface PilotBudgetContext {
  commandId: string
  executionId: string
  sessionId: string
}

/** 由 sessionId 反查 Pilot 受控执行归属；非 Pilot 会话返回 undefined，不注入出口。 */
export function resolvePilotBudgetForSession(sessionId: string): PilotBudgetContext | undefined {
  if (typeof sessionId !== 'string' || !sessionId) return undefined
  const execution = getAgentExecutionBySessionId(sessionId)
  if (!execution?.pilotCommandId || execution.status !== 'running' || execution.sessionId !== sessionId) return undefined
  return { commandId: execution.pilotCommandId, executionId: execution.id, sessionId }
}

export interface PilotRequestFetchInput extends PilotBudgetContext {
  priceEvidenceId?: string
  baseFetch: typeof globalThis.fetch
}

export function createPilotRequestFetch(input: PilotRequestFetchInput): typeof globalThis.fetch {
  const pilotFetch = async (rawInput: Parameters<typeof globalThis.fetch>[0],
    rawInit?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    const init = rawInit ?? {}
    const body = init.body
    // 只接受可逐字节核验的字符串请求体；流/二进制一律拒绝（fail-closed）。
    if (typeof body !== 'string' || body.length === 0) {
      throw new Error('Pilot 受控出口无法核验请求体，拒绝发送')
    }
    const envelope = derivePilotRequestEnvelope({
      body,
      priceEvidenceId: input.priceEvidenceId ?? PILOT_DEFAULT_PRICE_EVIDENCE_ID,
    })
    // requestId 只需全局唯一即可；崩溃后是否重复发送由请求体指纹唯一约束兜底。
    const requestId = `pilot-${randomUUID()}`
    reservePilotRequest({
      requestId,
      commandId: input.commandId,
      executionId: input.executionId,
      sessionId: input.sessionId,
      envelope,
    })
    verifyPilotRequestBody(requestId, body)
    return input.baseFetch(rawInput, { ...init, body })
  }
  return Object.assign(pilotFetch, { preconnect: () => {} })
}

/** 一次 turn 的完整受控运行时：同一闭包覆盖主 turn、压缩等全部请求，保证 requestId 序列共享。 */
export function buildPilotRequestRuntime(pilotBudget: PilotBudgetContext, baseFetch: typeof globalThis.fetch):
  { fetch: typeof globalThis.fetch; maxOutputTokens: number } {
  const evidence = getPilotReviewedPriceEvidence(PILOT_DEFAULT_PRICE_EVIDENCE_ID)
  if (!evidence) throw new Error('Pilot 默认价格证据不可用，拒绝构建受控出口')
  return {
    fetch: createPilotRequestFetch({ ...pilotBudget, baseFetch }),
    maxOutputTokens: evidence.maxModelOutputTokens,
  }
}
