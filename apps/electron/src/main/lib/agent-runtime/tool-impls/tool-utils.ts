/**
 * 工具实现共享工具函数
 *
 * 提供路径解析、安全校验、错误格式化等通用逻辑。
 */

import { resolve, relative, isAbsolute, dirname } from 'node:path'
import { realpathSync, existsSync, fstatSync, statSync } from 'node:fs'
import type { ToolResult } from '@gravitas/core'
import type { ToolContext } from '../types'

/**
 * 将用户提供的相对路径解析为绝对路径
 *
 * 规则：
 * - 绝对路径直接返回
 * - 相对路径基于 cwd 解析
 * - 返回路径必须在 cwd 内部（防止路径遍历，包括 symlink 绕过）
 */
/**
 * 校验已打开描述符与打开前捕获的 inode 基准一致（dev+ino 比对）。
 *
 * 抵御"路径检查通过后、打开前父目录被替换"的竞态：调用方在打开前 stat 目标路径
 * 固定 dev+ino，描述符被内核固定在打开瞬间的 inode 上，两者不一致即拒绝（失败关闭）。
 * 基准必须在打开前捕获——打开后再 stat 路径会跟随被替换后的父目录，失去检测能力。
 * 不用 /dev/fd 反查是因为 write-only 描述符在 macOS 返回 EACCES；dev+ino 与模式无关。
 */
export function assertDescriptorMatchesStat(descriptor: number, expected: { dev: number; ino: number }): void {
  const actual = fstatSync(descriptor)
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error('文件路径在打开过程中被替换，已拒绝访问')
  }
}

export function resolveToolPath(inputPath: string, cwd: string): { path: string; error?: string } {
  if (!inputPath) {
    return { path: '', error: '路径不能为空' }
  }

  const absolutePath = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath)

  // 解析 cwd 的真实路径（处理 symlink）
  let realCwd: string
  try {
    realCwd = realpathSync(cwd)
  } catch {
    realCwd = cwd
  }

  // 解析目标路径的真实路径；若目标不存在，则逐级向上找到存在的祖先目录再解析
  let realTargetPath: string
  try {
    realTargetPath = realpathSync(absolutePath)
  } catch {
    realTargetPath = resolveExistingAncestor(absolutePath)
  }

  const rel = relative(realCwd, realTargetPath)

  // 路径遍历检测：相对路径以 .. 开头或包含 ..\ / ../ 表示越界
  if (rel.startsWith('..') || rel.includes('..\\') || rel.includes('../')) {
    return { path: absolutePath, error: `路径越界：${inputPath} 不在工作目录 ${cwd} 内` }
  }

  return { path: absolutePath }
}

/**
 * 逐级向上查找真实存在的祖先目录，并返回其真实路径
 *
 * 用于目标文件尚不存在时（如 Write 工具），检测父目录是否通过 symlink 指向外部。
 */
function resolveExistingAncestor(absolutePath: string): string {
  let current = absolutePath
  while (current !== dirname(current)) {
    if (existsSync(current)) {
      try {
        return realpathSync(current)
      } catch {
        return current
      }
    }
    current = dirname(current)
  }
  // 到达根目录
  try {
    return realpathSync(current)
  } catch {
    return current
  }
}

/**
 * 将任意错误格式化为工具结果字符串
 */
export function formatToolError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error) || '未知错误'
}

/**
 * 截断过长的工具输出
 */
export function truncateOutput(output: string, maxLength = 100_000): string {
  if (output.length <= maxLength) return output
  return output.slice(0, maxLength) + `\n...（输出已截断，共 ${output.length} 字符）`
}

/** 受控身份从项目账本重查，不能只依赖工具调用方提供的标志。账本不可用时拒绝工具操作。 */
export function requiresOwnerToolGate(sessionId: string, ownerMarker?: boolean): boolean {
  const gates = require('../../project-owner-execution-gates') as typeof import('../../project-owner-execution-gates')
  const context = gates.resolveOwnerExecutionGateSession(sessionId)
  if (ownerMarker && context.kind === 'unrestricted') throw new Error('Owner工具标记与权威会话记录不一致')
  return context.kind !== 'unrestricted'
}

/** 对当前不在 Owner 工具白名单内的入口执行统一用途检查。 */
export function assertOwnerToolPermission(sessionId: string, ownerMarker: boolean | undefined, toolName: string, args: Record<string, unknown>, options?: { recordKnowledgeRead?: boolean }): void {
  if (!requiresOwnerToolGate(sessionId, ownerMarker)) return
  const gates = require('../../project-owner-execution-gates') as typeof import('../../project-owner-execution-gates')
  gates.assertToolAllowedForSessionPurpose(sessionId, toolName, args, options)
}

/**
 * 用途 + 身份一起校验：先比对运行时时绑定的会话身份，再判 Owner 用途。
 *
 * 供未走 guardOwnerTool 包装的工具（Grep、Agent 委派、记忆、联网读取）在自己的每个
 * 门禁点复用，保证"每次真正派发前都复核身份"的规则只有一处实现。
 */
export function assertOwnerToolGate(ctx: ToolContext, toolName: string, args: Record<string, unknown>, options?: { recordKnowledgeRead?: boolean }): void {
  const gates = require('../../project-owner-execution-gates') as typeof import('../../project-owner-execution-gates')
  gates.assertBoundToolSession(ctx)
  assertOwnerToolPermission(ctx.sessionId, ctx.ownerWorkspaceWrite, toolName, args, options)
}

/** 为工具入口提供统一的受控会话检查。 */
export function guardOwnerTool(toolName: string, execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult>): (input: unknown, ctx: ToolContext) => Promise<ToolResult> {
  return async (input, ctx) => {
    const args = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
    try {
      // 先校验运行时时绑定的会话身份，再校验用途：调用方替换 sessionId 不能绕过 Owner 门禁。
      const gates = require('../../project-owner-execution-gates') as typeof import('../../project-owner-execution-gates')
      gates.assertBoundToolSession(ctx)
      assertOwnerToolPermission(ctx.sessionId, ctx.ownerWorkspaceWrite, toolName, args, { recordKnowledgeRead: false })
    }
    catch (error) { return { toolCallId: '', content: formatToolError(error), isError: true } }
    return execute(input, ctx)
  }
}
