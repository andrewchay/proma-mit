/**
 * 工具实现共享工具函数
 *
 * 提供路径解析、安全校验、错误格式化等通用逻辑。
 */

import { resolve, relative, isAbsolute, dirname } from 'node:path'
import { realpathSync, existsSync } from 'node:fs'

/**
 * 将用户提供的相对路径解析为绝对路径
 *
 * 规则：
 * - 绝对路径直接返回
 * - 相对路径基于 cwd 解析
 * - 返回路径必须在 cwd 内部（防止路径遍历，包括 symlink 绕过）
 */
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
