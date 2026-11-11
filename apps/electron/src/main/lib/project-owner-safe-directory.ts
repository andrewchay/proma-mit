import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { app } from 'electron'
import { isProtectedDevelopmentPath, normalizeRepoRelativePath, pathWithinAllowed } from './development-path-policy'

interface OwnerSafeDirectoryNative { makeDirectories(root: string, relative: string): void }

/** 只创建已冻结目标的父目录，文件与后续写入权限不因目录创建而扩大。 */
export function prepareOwnerTargetDirectories(root: string, targets: readonly string[], allowedPaths: readonly string[], nativeOverride?: OwnerSafeDirectoryNative): void {
  const realRoot = realpathSync(root)
  if (realRoot !== resolve(root)) throw new Error('Owner工作树根目录不能是符号链接')
  let native = nativeOverride
  for (const raw of targets) {
    const target = normalizeRepoRelativePath(raw)
    if (target !== raw || isProtectedDevelopmentPath(target) || !pathWithinAllowed(target, allowedPaths)) throw new Error('Owner目标目录不在冻结研发范围内')
    const parent = dirname(target).split(sep).join('/')
    if (parent === '.') continue
    const segments = parent.split('/')
    let current = realRoot, missing = false
    for (const segment of segments) {
      current = join(current, segment)
      if (!existsSync(current)) { missing = true; break }
      const stat = lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Owner目标目录包含符号链接或非目录')
    }
    if (!missing) continue
    if (!native) {
      if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('当前平台尚不支持安全创建缺失目录，请选择已有目录')
      const resources = app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
      const packagedPath = join(resources, 'owner-safe-directory', 'owner_safe_directory.node')
      const sourcePath = join(__dirname, '../../../resources/owner-safe-directory/owner_safe_directory.node')
      const path = !app.isPackaged && !existsSync(packagedPath) ? sourcePath : packagedPath
      if (!existsSync(path)) throw new Error('Owner安全目录模块未就绪，请重新构建应用')
      const loaded: unknown = require(path)
      if (!loaded || typeof loaded !== 'object' || !('makeDirectories' in loaded) || typeof loaded.makeDirectories !== 'function') throw new Error('Owner安全目录模块接口无效')
      native = loaded as OwnerSafeDirectoryNative
    }
    native.makeDirectories(realRoot, parent)
  }
}
