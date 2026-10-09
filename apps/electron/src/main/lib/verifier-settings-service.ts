/**
 * 验证器设置服务：设置界面的读写入口。
 *
 * 只操作受保护存储（HMAC 签名 + safeStorage 密钥）。保存会递增修订，
 * 引用旧修订的 Goal 完成时会被拒绝并提示重新创建。
 */

import type { SaveVerifierInput, VerifierSummary } from '@gravitas/shared'
import { ProtectedVerifierStore } from './protected-verifier-store'
import { validatePinnedVerifierConfig } from './pinned-baseline-verifier'
import { assertProtectedPatterns } from './completion-protected-paths'

export class VerifierSettingsService {
  constructor(private readonly store: ProtectedVerifierStore = new ProtectedVerifierStore()) {}

  list(): VerifierSummary[] {
    return this.store.listIds().map((verifierId) => {
      try {
        const stored = this.store.load(verifierId)
        return {
          verifierId, revision: stored.record.revision, recordSha256: stored.recordSha256,
          protectedPaths: stored.record.protectedPaths, config: stored.record.config, savedAt: stored.record.savedAt,
        }
      } catch (error) {
        return {
          verifierId, revision: 0, recordSha256: '', protectedPaths: [], config: { version: 1 as const, verifierId, argv: [] as string[], expectedExitCodes: [] as number[], timeoutMs: 0, minimumTests: 0 },
          savedAt: '', error: error instanceof Error ? error.message : '读取失败',
        }
      }
    }).sort((a, b) => a.verifierId.localeCompare(b.verifierId))
  }

  save(input: SaveVerifierInput): VerifierSummary {
    validatePinnedVerifierConfig(input.config)
    assertProtectedPatterns(input.protectedPaths)
    const stored = this.store.save(input.verifierId, input.config, input.protectedPaths)
    return {
      verifierId: input.verifierId, revision: stored.record.revision, recordSha256: stored.recordSha256,
      protectedPaths: stored.record.protectedPaths, config: stored.record.config, savedAt: stored.record.savedAt,
    }
  }
}

export const verifierSettingsService = new VerifierSettingsService()
