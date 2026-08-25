/**
 * Enterprise 连接状态 atoms
 */

import { atom } from 'jotai'

export interface EnterpriseConnection {
  serverUrl: string
  authMode: 'none' | 'local' | 'oidc'
  scope: {
    tenantId: string
    userId: string
    roles: string[]
  }
}

/** 当前企业版连接状态 */
export const enterpriseConnectionAtom = atom<EnterpriseConnection | null>(null)
