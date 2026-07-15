/**
 * 工具实现共享工具函数
 *
 * 提供路径解析、安全校验、错误格式化等通用逻辑。
 */

import { resolve, relative, isAbsolute } from 'node:path'

/**
 * 将用户提供的相对路径解析为绝对路径
 *
 * 规则：
 * - 绝对路径直接返回
 * - 相对路径基于 cwd 解析
 * - 返回路径必须在 cwd 内部（防止路径遍历）
 */
export function resolveToolPath(inputPath: string, cwd: string): { path: string; error?: string } {
  if (!inputPath) {
    return { path: '', error: '路径不能为空' }
  }

  const absolutePath = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath)
  const rel = relative(cwd, absolutePath)

  // 路径遍历检测：相对路径以 .. 开头或包含 ..\ / ../ 表示越界
  if (rel.startsWith('..') || rel.includes('..\\') || rel.includes('../')) {
    return { path: absolutePath, error: `路径越界：${inputPath} 不在工作目录 ${cwd} 内` }
  }

  return { path: absolutePath }
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
