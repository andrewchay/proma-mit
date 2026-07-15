/**
 * Grep 工具实现
 *
 * 在工作目录下搜索匹配正则表达式的文件内容。
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolResult } from '@proma/core'
import type { ToolContext } from '../types.ts'
import { resolveToolPath, formatToolError, truncateOutput } from './tool-utils.ts'

const execAsync = promisify(exec)

export interface GrepToolInput {
  path?: string
  regex: string
}

export const GREP_TOOL_NAME = 'Grep'

export function createGrepToolDefinition() {
  return {
    name: GREP_TOOL_NAME,
    description: '在工作目录下搜索匹配正则表达式的文件内容。优先使用 ripgrep，否则使用 grep。',
    parameters: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: '要搜索的目录或文件路径，相对于当前工作目录（可选，默认当前工作目录）',
        },
        regex: {
          type: 'string',
          description: '要匹配的正则表达式',
        },
      },
      required: ['regex'],
    },
  }
}

export async function executeGrepTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const params = input as GrepToolInput
  const targetPath = params.path ?? '.'
  const { path, error: pathError } = resolveToolPath(targetPath, ctx.cwd)
  if (pathError) {
    return { toolCallId: '', content: pathError, isError: true }
  }

  try {
    // 优先尝试 rg，否则使用 grep -r
    const hasRg = await commandExists('rg')
    const command = hasRg
      ? `rg -n --max-count 50 "${escapeShellArg(params.regex)}" "${path}"`
      : `grep -rn --max-count=50 "${escapeShellArg(params.regex)}" "${path}"`

    const { stdout, stderr } = await execAsync(command, {
      cwd: ctx.cwd,
      timeout: 30_000,
      env: process.env,
    })

    const output = stdout || stderr || '[无匹配结果]'
    return {
      toolCallId: '',
      content: truncateOutput(output),
    }
  } catch (error) {
    // grep/rg 未找到匹配时通常返回非零退出码，但 stderr 可能为空
    const message = formatToolError(error)
    if (message.includes('No such file') || message.includes('没有那个文件')) {
      return { toolCallId: '', content: message, isError: true }
    }
    return {
      toolCallId: '',
      content: truncateOutput(message) || '[无匹配结果]',
      isError: false,
    }
  }
}

/**
 * 检查命令是否存在于 PATH 中
 */
async function commandExists(command: string): Promise<boolean> {
  try {
    await execAsync(`command -v ${command}`, { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

/**
 * 转义 shell 参数中的特殊字符
 */
function escapeShellArg(arg: string): string {
  return arg.replace(/"/g, '\\"')
}
