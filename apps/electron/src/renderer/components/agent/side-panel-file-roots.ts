/** 相同路径只展示一棵文件树，避免重复读取与渲染。 */
export function hasSeparateRepositoryRoot(sessionPath: string | null | undefined, repositoryPath: string | null | undefined): boolean {
  if (!repositoryPath) return false
  if (!sessionPath) return true
  const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalize(sessionPath) !== normalize(repositoryPath)
}
