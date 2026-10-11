/**
 * 验证器设置服务：设置界面的读写入口。
 *
 * 只操作受保护存储（HMAC 签名 + safeStorage 密钥）。保存会递增修订，
 * 引用旧修订的 Goal 完成时会被拒绝并提示重新创建。
 */

import type { GoalCompletionGate, SaveVerifierInput, VerifierSummary } from '@gravitas/shared'
import { ProtectedVerifierStore } from './protected-verifier-store'
import { validatePinnedVerifierConfig } from './pinned-baseline-verifier'
import { assertProtectedPatterns } from './completion-protected-paths'
import { resolveHeadCommitSha } from './pinned-baseline-verifier'

export class VerifierSettingsService {
  constructor(readonly store: ProtectedVerifierStore = new ProtectedVerifierStore()) {}

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

/** 为 Goal 构建完成门禁：引用存储中最新修订，基线省略时取仓库当前 HEAD。 */
export function buildCompletionGateForGoal(input: { repoRoot: string; verifierId: string; baselineCommitSha?: string }): GoalCompletionGate {
  const stored = verifierSettingsService.store.load(input.verifierId)
  const baselineCommitSha = input.baselineCommitSha ?? resolveHeadCommitShaSyncless(input.repoRoot)
  return {
    version: 1,
    repoRoot: input.repoRoot,
    baselineCommitSha,
    verifierRef: { verifierId: input.verifierId, revision: stored.record.revision, recordSha256: stored.recordSha256 },
  }
}

function resolveHeadCommitShaSyncless(repoRoot: string): string {
  // resolveHeadCommitSha 是异步的；此处用同步版本保持绑定接口简单。
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
  const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('无法解析仓库 HEAD 提交')
  return sha
}

export const verifierSettingsService = new VerifierSettingsService()
