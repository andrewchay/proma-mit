/**
 * 固定基线验证的 macOS seatbelt 沙箱。
 *
 * 默认拒绝一切写入；只允许写入验证工作目录与用户临时目录，并显式拒绝读写配置目录（含签名密钥）。
 * 路径必须是真实路径（realpath）：SBPL 按字面匹配，/var 与 /private/var 不等价。
 * 非 macOS 平台不提供此隔离，调用方应直接判为 unknown。
 */

export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec'

/** SBPL 字符串转义：只处理反斜杠与双引号。 */
function quote(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export interface SeatbeltPolicy {
  /** 真实路径子树；允许写入。 */
  readonly writableRoots: readonly string[]
  /** 真实字面路径；允许写入（不含子树）。 */
  readonly writableLiterals?: readonly string[]
  /** 真实路径子树；读写均拒绝（配置目录等）。 */
  readonly denyRoots: readonly string[]
  /** 真实路径子树；仅拒绝写入（如 git hooks）。 */
  readonly denyWriteRoots?: readonly string[]
  /** 真实字面路径；仅拒绝写入（如 git config）。 */
  readonly denyWriteLiterals?: readonly string[]
}

export function buildSeatbeltProfile(policy: SeatbeltPolicy): string {
  const allows = [
    ...policy.writableRoots.map((root) => `(subpath ${quote(root)})`),
    ...(policy.writableLiterals ?? []).map((path) => `(literal ${quote(path)})`),
  ].join(' ')
  const denyRoots = policy.denyRoots.map((root) => `(subpath ${quote(root)})`).join(' ')
  const denyWriteRoots = (policy.denyWriteRoots ?? []).map((root) => `(subpath ${quote(root)})`).join(' ')
  const denyWriteLiterals = (policy.denyWriteLiterals ?? []).map((path) => `(literal ${quote(path)})`).join(' ')
  // SBPL 后出现的规则优先：先允许，再针对禁止项覆盖。
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${allows} (literal "/dev/null"))`,
    ...(denyRoots ? [`(deny file-read* ${denyRoots})`, `(deny file-write* ${denyRoots})`] : []),
    ...(denyWriteRoots ? [`(deny file-write* ${denyWriteRoots})`] : []),
    ...(denyWriteLiterals ? [`(deny file-write* ${denyWriteLiterals})`] : []),
  ].join('\n')
}

/** 将命令包装为 sandbox-exec 调用；argv 仍为数组，不经 shell。 */
export function wrapWithSeatbelt(argv: readonly string[], policy: SeatbeltPolicy): string[] {
  return [SANDBOX_EXEC_PATH, '-p', buildSeatbeltProfile(policy), ...argv]
}
