/**
 * Goal 完成门禁：基线之后的受保护路径改动检查（决策 b）。
 *
 * 只比较已提交内容：基线必须是 HEAD 的祖先，且 `git diff` 中不得出现受保护路径。
 * 删除与重命名均按“旧路径改动”计入（--no-renames），不做重命名折叠。
 */

import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

export type ProtectedPathReason = 'baseline_not_ancestor' | 'protected_paths_changed' | 'git_failed'

export interface ProtectedPathAssessment {
  readonly ok: boolean
  readonly reasons: readonly ProtectedPathReason[]
  readonly violations: readonly string[]
}

/** 将受保护模式编译为正则；只支持 `**\/`、`*` 与目录前缀，拒绝绝对路径与 `..`。 */
function compilePattern(pattern: string): RegExp {
  const normalized = pattern.trim().replace(/^\.\//, '')
  if (!normalized || isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`protectedPaths 模式无效：${pattern}`)
  }
  const escaped = normalized
    .split('**/').map((part) => part.split('*').map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('(?:.*/)?')
  const suffix = normalized.endsWith('/') ? '.*' : ''
  return new RegExp(`^${escaped}${suffix}$`)
}

export function matchesProtectedPath(pattern: string, path: string): boolean {
  return compilePattern(pattern).test(path)
}

/** 创建门禁时校验模式列表；空列表表示没有受保护路径，需显式给出。 */
export function assertProtectedPatterns(patterns: readonly string[]): void {
  if (patterns.length === 0) throw new Error('protectedPaths 不能为空，至少声明一个受保护模式')
  for (const pattern of patterns) compilePattern(pattern)
}

function git(repoRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

export async function assessProtectedPathChanges(input: {
  repoRoot: string
  baselineCommitSha: string
  headCommitSha: string
  protectedPaths: readonly string[]
}): Promise<ProtectedPathAssessment> {
  if (!isAbsolute(input.repoRoot)) throw new Error('repoRoot 必须是绝对路径')
  const matchers = input.protectedPaths.map(compilePattern)
  try {
    try {
      await git(input.repoRoot, ['merge-base', '--is-ancestor', input.baselineCommitSha, input.headCommitSha])
    } catch {
      return { ok: false, reasons: ['baseline_not_ancestor'], violations: [] }
    }
    const output = await git(input.repoRoot, ['diff', '--name-only', '--no-renames', '-z', input.baselineCommitSha, input.headCommitSha, '--'])
    const changed = output.split('\0').filter(Boolean)
    const violations = changed.filter((path) => matchers.some((matcher) => matcher.test(path)))
    return violations.length === 0
      ? { ok: true, reasons: [], violations: [] }
      : { ok: false, reasons: ['protected_paths_changed'], violations }
  } catch {
    return { ok: false, reasons: ['git_failed'], violations: [] }
  }
}
