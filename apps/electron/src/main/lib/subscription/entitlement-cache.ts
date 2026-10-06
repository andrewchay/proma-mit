import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EntitlementSnapshot } from '@gravitas/shared'
import { getSubscriptionEntitlementCachePath } from '../config-paths'

export interface CachedEntitlement {
  snapshot: EntitlementSnapshot
  cachedAt: number
}

export class EntitlementCache {
  private cache: CachedEntitlement | undefined

  load(): CachedEntitlement | undefined {
    if (this.cache) return this.cache
    const path = getSubscriptionEntitlementCachePath()
    if (!existsSync(path)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as CachedEntitlement
      this.cache = parsed
      return parsed
    } catch {
      return undefined
    }
  }

  save(snapshot: EntitlementSnapshot): void {
    const payload: CachedEntitlement = { snapshot, cachedAt: Date.now() }
    const path = getSubscriptionEntitlementCachePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
    this.cache = payload
  }

  clear(): void {
    this.cache = undefined
    const path = getSubscriptionEntitlementCachePath()
    if (existsSync(path)) rmSync(path)
  }
}
