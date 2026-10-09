/**
 * 固定基线验证的 macOS seatbelt 沙箱。
 *
 * 默认拒绝一切写入；只允许写入验证工作目录与用户临时目录，并显式拒绝读写配置目录（含签名密钥）。
 * 路径必须是真实路径（realpath）：SBPL 按字面匹配，/var 与 /private/var 不等价。
 * 非 macOS 平台不提供此隔离，调用方应直接判为 unknown。
 */

export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec'

export interface SeatbeltPolicy {
  /** 真实路径；允许写入。 */
  readonly writableRoots: readonly string[]
  /** 真实路径；显式拒绝读写（配置目录等），优先级高于允许规则。 */
  readonly denyRoots: readonly string[]
}

/** SBPL 字符串转义：只处理反斜杠与双引号。 */
function quote(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function buildSeatbeltProfile(policy: SeatbeltPolicy): string {
  const allows = policy.writableRoots.map((root) => `(subpath ${quote(root)})`).join(' ')
  const denies = policy.denyRoots.map((root) => `(subpath ${quote(root)})`).join(' ')
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${allows} (literal "/dev/null"))`,
    ...(policy.denyRoots.length > 0 ? [`(deny file-read* ${denies})`, `(deny file-write* ${denies})`] : []),
  ].join('\n')
}

/** 将命令包装为 sandbox-exec 调用；argv 仍为数组，不经 shell。 */
export function wrapWithSeatbelt(argv: readonly string[], policy: SeatbeltPolicy): string[] {
  return [SANDBOX_EXEC_PATH, '-p', buildSeatbeltProfile(policy), ...argv]
}
