/**
 * 浏览器验证命令的解析与执行。
 *
 * 目的：让运行验证复用既有验证管线的证据格式与门禁，而不是新开一条平行通路。
 * 命令形如 `browser:html.loads+dom.board`：前缀之后的每一项必须是内置断言标识。
 * 边界：
 * - 断言标识必须在内置注册表中，未知标识直接报错，不静默跳过；
 * - 只验证任务研发范围内已存在的 HTML 目标文件；
 * - 退出码与输出摘要由断言结果派生，供既有 fresh/截断/哈希门禁判定。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { resolveOwnerRuntimeAssertionTemplates } from './owner-runtime-assertion-templates'
import { runOwnerRuntimeBrowserAssertions, type OwnerRuntimeBrowserCheckResult } from './owner-runtime-browser-verifier'

export const BROWSER_VERIFICATION_PREFIX = 'browser:'

export function isBrowserVerificationCommand(command: string): boolean {
  return command.trim().startsWith(BROWSER_VERIFICATION_PREFIX)
}

/** 解析 `browser:a+b` 中的断言标识；空列表或未知标识都视为配置错误。 */
export function parseBrowserVerificationCheckIds(command: string): string[] {
  const trimmed = command.trim()
  if (!isBrowserVerificationCommand(trimmed)) throw new Error(`不是浏览器验证命令：${command}`)
  const ids = trimmed.slice(BROWSER_VERIFICATION_PREFIX.length).split('+').map(item => item.trim()).filter(Boolean)
  if (ids.length === 0) throw new Error('浏览器验证命令缺少断言标识')
  if (new Set(ids).size !== ids.length) throw new Error('浏览器验证命令存在重复断言标识')
  // 复用注册表校验，未知标识在这里就会抛错。
  resolveOwnerRuntimeAssertionTemplates(ids)
  return ids
}

/** 从研发范围的 targetPaths 中挑出实际存在的 HTML 文件（相对路径）。 */
export function selectBrowserVerificationTargets(workspaceRoot: string, targetPaths: readonly string[]): string[] {
  const root = resolve(workspaceRoot)
  const targets = targetPaths.filter((path) => {
    if (isAbsolute(path)) return false
    if (!['.html', '.htm'].includes(extname(path).toLowerCase())) return false
    const absolute = resolve(root, path)
    const inside = relative(root, absolute)
    return Boolean(inside) && !inside.startsWith('..') && existsSync(absolute)
  })
  if (targets.length === 0) throw new Error('研发范围内没有可验证的 HTML 目标文件')
  return [...new Set(targets)]
}

export interface BrowserVerificationOutcome {
  checks: OwnerRuntimeBrowserCheckResult[]
  exitCode: number
  timedOut: boolean
  output: string
  outputTruncated: boolean
  rawOutputSha256: string
  rawOutputByteLength: number
}

/**
 * 对每个目标文件执行同一组断言，按文件前缀聚合结果。
 * 任一断言失败或超时即整体失败；输出摘要基于完整断言结果计算，供既有门禁核验。
 */
export async function executeBrowserVerificationCommand(input: {
  workspaceRoot: string
  targetPaths: readonly string[]
  command: string
  timeoutMs: number
}): Promise<BrowserVerificationOutcome> {
  const checkIds = parseBrowserVerificationCheckIds(input.command)
  const targets = selectBrowserVerificationTargets(input.workspaceRoot, input.targetPaths)
  const perFileBudget = Math.max(5_000, Math.floor(input.timeoutMs / targets.length))
  const templates = resolveOwnerRuntimeAssertionTemplates(checkIds)
  const collected: OwnerRuntimeBrowserCheckResult[] = []
  let timedOut = false
  for (const target of targets) {
    const result = await runOwnerRuntimeBrowserAssertions({
      workspaceRoot: input.workspaceRoot,
      relativePath: target,
      intents: [],
      timeoutMs: perFileBudget,
      templates,
    })
    timedOut = timedOut || result.timedOut
    for (const check of result.checks) {
      collected.push(targets.length > 1 ? { ...check, id: `${target}#${check.id}`, title: `${target}：${check.title}` } : check)
    }
  }
  const output = JSON.stringify(collected)
  // skipped 不是通过：Owner 明确声明了这条验收，环境不适用就必须如实失败，不能靠跳过凑绿。
  const hasFailure = collected.length === 0 || collected.some(check => check.status !== 'passed')
  return {
    checks: collected,
    exitCode: timedOut ? 1 : hasFailure ? 1 : 0,
    timedOut,
    output,
    // 断言结果本身很短，但仍按同一规则标注截断，避免将来放宽时误判。
    outputTruncated: false,
    rawOutputSha256: createHash('sha256').update(output, 'utf8').digest('hex'),
    rawOutputByteLength: Buffer.byteLength(output, 'utf8'),
  }
}
