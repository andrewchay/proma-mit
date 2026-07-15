/**
 * Bash 工具实现
 *
 * 在工作目录下执行 shell 命令，支持超时控制。
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolResult } from '@proma/core'
import type { ToolContext } from '../types.ts'
import { formatToolError, truncateOutput } from './tool-utils.ts'

const execAsync = promisify(exec)

export interface BashToolInput {
  command: string
  timeout?: number
}

export const BASH_TOOL_NAME = 'Bash'

export function createBashToolDefinition() {
  return {
    name: BASH_TOOL_NAME,
    description: '在当前工作目录下执行 shell 命令。只读命令优先；写操作需经用户确认。',
    parameters: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: '要执行的 shell 命令',
        },
        timeout: {
          type: 'number',
          description: '命令超时时间（毫秒，默认 30000）',
        },
      },
      required: ['command'],
    },
  }
}

export async function executeBashTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const params = input as BashToolInput
  const command = params.command.trim()
  if (!command) {
    return { toolCallId: '', content: '命令不能为空', isError: true }
  }

  const timeout = params.timeout ?? 30_000

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: ctx.cwd,
      timeout,
      env: process.env,
    })

    const output = stdout || stderr || '[无输出]'
    return {
      toolCallId: '',
      content: truncateOutput(output),
    }
  } catch (error) {
    const message = formatToolError(error)
    return {
      toolCallId: '',
      content: truncateOutput(message),
      isError: true,
    }
  }
}
