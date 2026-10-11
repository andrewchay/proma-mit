import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isToolEffectsDataRecord } from '@gravitas/shared'
import type { ToolContext, RuntimeToolDefinition } from './types'
import { getRegisteredToolEffects } from './tool-effects'
import { resolveToolPath } from './tool-impls/tool-utils'

export interface ObservedFileIdentity { readonly device: string; readonly inode: string }
export interface ObservedFilesystemResource {
  readonly mode: 'read' | 'write'
  readonly scope: 'path' | 'path-and-ancestors'
  readonly lexicalPath: string
  readonly canonicalPath: string
  readonly realCwd: string
  readonly existingAncestor: string
  readonly targetExists: boolean
  readonly identity?: ObservedFileIdentity
  readonly coveredPaths: readonly string[]
}
export interface ResolvedToolResources { readonly status: 'resolved'; readonly resources: readonly ObservedFilesystemResource[] }
export interface UnknownToolResources { readonly status: 'unknown'; readonly reason: string }
export type ToolResourceObservation = ResolvedToolResources | UnknownToolResources
interface CanonicalTarget { path: string; ancestor: string; exists: boolean }
function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
/** 只允许真正缺失节点向上；悬空link、ENOTDIR和其他错误不猜测。 */
function observeCanonicalTarget(path: string): CanonicalTarget {
  let current = path
  const suffix: string[] = []
  for (;;) {
    try {
      const canonical = realpathSync(current)
      if (suffix.length > 0 && !statSync(canonical).isDirectory()) throw new Error('祖先不是目录')
      return { path: join(canonical, ...suffix), ancestor: suffix.length === 0 ? dirname(canonical) : canonical, exists: suffix.length === 0 }
    } catch (error) {
      if (!missing(error)) throw error
      try {
        lstatSync(current)
        // realpath不存在但lstat存在：典型悬空link，不得丢失它的目标语义。
        throw new Error('无法确定现存节点的真实路径')
      } catch (nodeError) {
        if (!missing(nodeError)) throw nodeError
      }
      const parent = dirname(current)
      if (parent === current) throw new Error('找不到现存祖先')
      suffix.unshift(basename(current))
      current = parent
    }
  }
}
function coveredPaths(path: string, scope: ObservedFilesystemResource['scope']): string[] {
  const result = [path]
  if (scope === 'path-and-ancestors') {
    let current = path
    while (current !== dirname(current)) { current = dirname(current); result.push(current) }
  }
  return result
}
/** 非原子观察，不是权限、锁或TOCTOU防护；未知须由未来调度保守处理。 */
export function resolveRegisteredToolResources(tool: RuntimeToolDefinition, input: unknown, ctx: ToolContext): ToolResourceObservation {
  const unknown = (reason: string): UnknownToolResources => ({ status: 'unknown', reason })
  const effects = getRegisteredToolEffects(tool)
  if (effects.resources.some((r) => r.kind !== 'filesystem')) return unknown('工具缺少有效实例声明')
  if (!isToolEffectsDataRecord(input) || !isToolEffectsDataRecord(ctx) || typeof ctx.cwd !== 'string' || !isAbsolute(ctx.cwd)) return unknown('输入或cwd不是普通绝对路径数据')
  try {
    const realCwd = realpathSync(ctx.cwd)
    if (!statSync(realCwd).isDirectory()) return unknown('cwd不是目录')
    const resources: ObservedFilesystemResource[] = []
    for (const effect of effects.resources) {
      if (effect.kind !== 'filesystem') return unknown('未知资源')
      const inputPath = Object.getOwnPropertyDescriptor(input, effect.pathParameter)?.value as unknown
      if (typeof inputPath !== 'string' || !inputPath.trim() || inputPath.includes('\0')) return unknown('资源路径无效')
      const target = resolveToolPath(inputPath, ctx.cwd)
      if (target.error) return unknown('既有路径范围校验未通过')
      // 旧工具对绝对路径不做词法折叠；有缺失中间节点时不能假装../已被内核解析。
      if (target.path !== resolve(target.path)) return unknown('非规范路径无法可靠观察')
      const canonical = observeCanonicalTarget(target.path)
      const rel = relative(realCwd, canonical.path)
      if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) return unknown('完整真实目标越界')
      let identity: ObservedFileIdentity | undefined
      if (canonical.exists) {
        const stat = statSync(canonical.path, { bigint: true })
        if (!stat.isFile()) return unknown('目标不是普通文件')
        identity = { device: stat.dev.toString(), inode: stat.ino.toString() }
      } else if (effect.mode !== 'write' || effect.scope !== 'path-and-ancestors') return unknown('读取或编辑目标不存在')
      resources.push({ mode: effect.mode, scope: effect.scope, lexicalPath: target.path, canonicalPath: canonical.path,
        realCwd, existingAncestor: canonical.ancestor, targetExists: canonical.exists, identity,
        coveredPaths: coveredPaths(canonical.path, effect.scope) })
    }
    return { status: 'resolved', resources }
  } catch {
    return unknown('文件系统观察失败，未推断锁或权限')
  }
}
