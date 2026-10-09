/**
 * Goal 完成门禁的共享契约：固定基线验证配置与回执。
 * 配置由主进程读取与执行；回执只描述一次固定基线验证的事实，不代表业务验收。
 */

export interface PinnedVerifierConfig {
  readonly version: 1
  readonly verifierId: string
  /** 完整 argv；首项为可执行文件，不经 shell 解释。`{{JUNIT_REPORT}}` 由主进程替换为副本外报告路径。 */
  readonly argv: readonly string[]
  readonly expectedExitCodes: readonly number[]
  readonly timeoutMs: number
  /** 至少要采集到的测试数量；零测试不得通过。 */
  readonly minimumTests: number
}

/** Goal 上记录的完成门禁：验证对象是仓库 HEAD 指向的已提交内容。 */
export interface GoalCompletionGate {
  readonly version: 1
  /** 绝对路径的 Git 仓库根目录。 */
  readonly repoRoot: string
  readonly verifier: PinnedVerifierConfig
}

export type PinnedVerifierReason =
  | 'exit_code_unexpected'
  | 'timeout'
  | 'collection_missing'
  | 'too_few_tests'
  | 'test_failures'
  | 'spawn_error'

export interface PinnedVerifierReceipt {
  readonly version: 1
  readonly verifierId: string
  readonly commitSha: string
  readonly argvSha256: string
  readonly cleanCheckout: true
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly tests: number
  readonly failures: number
  readonly errors: number
  readonly skipped: number
  readonly verdict: 'passed' | 'failed' | 'unknown'
  readonly reasons: readonly PinnedVerifierReason[]
  readonly cleanedUp: boolean
  readonly startedAt: string
  readonly finishedAt: string
}
