/**
 * Bash 工具实现
 *
 * 在工作目录下执行 shell 命令，支持超时控制。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolResult } from '@gravitas/core'
import type { ToolContext } from '../types.ts'
import { formatToolError, truncateOutput } from './tool-utils.ts'
import { prepareBashSandbox } from './bash-sandbox.ts'

const execFileAsync = promisify(execFile)

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

/** 在 seatbelt 沙箱中执行 shell 命令；非 macOS 平台默认拒绝（无隔离不执行）。 */
export async function executeBashTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  return executeBashToolOnPlatform(input, ctx, process.platform)
}

export async function executeBashToolOnPlatform(input: unknown, ctx: ToolContext, platform: NodeJS.Platform): Promise<ToolResult> {
  const params = input as BashToolInput
  const command = params.command.trim()
  if (!command) {
    return { toolCallId: '', content: '命令不能为空', isError: true }
  }
  if (platform !== 'darwin') {
    return { toolCallId: '', content: '当前平台尚未提供 Bash 沙箱，已拒绝执行 shell 命令（默认拒绝）', isError: true }
  }

  const timeout = params.timeout ?? 30_000

  try {
    const sandbox = await prepareBashSandbox(ctx.cwd, ctx.sessionId)
    const [command0, ...rest] = sandbox.argv as [string, ...string[]]
    const { stdout, stderr } = await execFileAsync(command0, [...rest, command], {
      cwd: ctx.cwd,
      timeout,
      env: sandbox.env,
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
