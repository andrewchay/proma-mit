/** 研发范围共用路径策略；保持纯函数，供协议校验与文件系统服务复用。 */

/** 受保护路径段：敏感项在仓库任意层级都受保护。 */
const PROTECTED_PATH_SEGMENTS: RegExp[] = [
  /^\.git$/,
  /^\.env(?:\..*)?$/i,
  /^AGENTS\.md$/,
  /^\.context$/,
  /^(package-lock\.json|bun\.lock|bun\.lockb|yarn\.lock|pnpm-lock\.yaml)$/,
  /\.(pem|key|p12|pfx)$/i,
  /^id_rsa[^/]*$/i,
  /^credentials?\.(json|txt)$/i,
  /^secrets?$/i,
]

export function isProtectedDevelopmentPath(path: string): boolean {
  return path.split('/').some((segment) => PROTECTED_PATH_SEGMENTS.some((pattern) => pattern.test(segment)))
}

/** 清洗仓库相对路径，拒绝绝对路径、父目录、反斜杠及空路径段。 */
export function normalizeRepoRelativePath(raw: string): string {
  if (typeof raw !== 'string') throw new Error('路径必须是字符串')
  const value = raw.trim()
  if (!value) throw new Error('路径不能为空')
  if (value.includes('\0')) throw new Error(`路径包含非法字符：${JSON.stringify(raw)}`)
  if (value.includes('\\')) throw new Error(`路径必须使用 POSIX 分隔符，拒绝反斜杠：${raw}`)
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new Error(`拒绝绝对路径：${raw}`)
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`路径段不能为空、「.」或「..」：${raw}`)
  }
  return segments.join('/')
}

/** 判断仓库相对路径是否位于某个允许前缀下，按路径段匹配。 */
export function pathWithinAllowed(path: string, allowedPaths: readonly string[]): boolean {
  const segments = path.split('/')
  return allowedPaths.some((allowed) => {
    const allowedSegments = allowed.split('/')
    if (allowedSegments.length > segments.length) return false
    return allowedSegments.every((segment, index) => segment === segments[index])
  })
}
