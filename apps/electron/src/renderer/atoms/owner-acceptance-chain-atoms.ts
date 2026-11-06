import { atom } from 'jotai'
import type { OwnerChainDecisionRequest, ProjectChain } from '@gravitas/shared'

/** 保持权威链的最新投影；较慢的旧读取不能覆盖新决定。 */
export const ownerAcceptanceChainsAtom = atom(new Map<string, ProjectChain>())
export const ownerAcceptancePendingAtom = atom(new Map<string, OwnerChainDecisionRequest>())
export const rememberOwnerAcceptanceChainAtom = atom(null, (get, set, input: { projectId: string; chain: ProjectChain }) => {
  const chains = new Map(get(ownerAcceptanceChainsAtom))
  if ((chains.get(input.projectId)?.revision ?? -1) > input.chain.revision) return
  chains.set(input.projectId, input.chain)
  set(ownerAcceptanceChainsAtom, chains)
})
