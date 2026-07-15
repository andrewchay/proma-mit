/**
 * Grep 工具实现
 *
 * 在工作目录下搜索匹配正则表达式的文件内容。
 * 使用 spawn + 参数数组执行，避免 shell 注入。
 */

import { spawn } from 'node:child_process'
import type { ToolResult } from '@proma/core'
import type { ToolContext } from '../types.ts'
import { resolveToolPath, formatToolError, truncateOutput } from './tool-utils.ts'

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
    const hasRg = await commandExists('rg')
    const args = hasRg
      ? ['-n', '--max-count', '50', params.regex, path]
      : ['-rn', '--max-count=50', params.regex, path]
    const command = hasRg ? 'rg' : 'grep'

    const { stdout, stderr, exitCode } = await runCommand(command, args, { cwd: ctx.cwd, timeout: 30_000 })

    if (exitCode !== 0 && !stdout && !stderr) {
      return { toolCallId: '', content: '[无匹配结果]' }
    }

    const output = stdout || stderr || '[无匹配结果]'
    return {
      toolCallId: '',
      content: truncateOutput(output),
    }
  } catch (error) {
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
 * 使用 spawn 执行命令，避免 shell 注入
 */
function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('命令执行超时'))
    }, options.timeout)

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf-8')
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf-8')
    })

    child.on('error', (error) => {
      clearTimeout(timeoutId)
      reject(error)
    })

    child.on('close', (exitCode) => {
      clearTimeout(timeoutId)
      resolve({ stdout, stderr, exitCode: exitCode ?? 0 })
    })
  })
}

/**
 * 检查命令是否存在于 PATH 中（使用 spawn，不走 shell）
 */
async function commandExists(command: string): Promise<boolean> {
  try {
    await runCommand('command', ['-v', command], { cwd: process.cwd(), timeout: 5_000 })
    return true
  } catch {
    return false
  }
}
