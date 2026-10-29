/**
 * Bash 工具实现
 *
 * 在工作目录下执行 shell 命令，支持超时控制。
 */

import type { ToolResult } from '@gravitas/core'
import type { ToolContext } from '../types.ts'
import { formatToolError, truncateOutput, requiresOwnerToolGate } from './tool-utils.ts'
import { prepareBashSandbox, quarantineNewGitArtifacts } from './bash-sandbox.ts'
import { describeBashTermination, runBashCommand } from './bash-termination.ts'

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

  // 沙箱准备结果提升到 try 外，使命令失败路径也能按同一份 gitWasPresent 收口。
  let sandbox: Awaited<ReturnType<typeof prepareBashSandbox>> | undefined
  try {
    const assertOwnerGate = () => {
      if (!requiresOwnerToolGate(ctx.sessionId, ctx.ownerWorkspaceWrite)) return
      const gates = require('../../project-owner-execution-gates') as typeof import('../../project-owner-execution-gates')
      gates.assertToolAllowedForSessionPurpose(ctx.sessionId, 'Bash', { command })
    }
    assertOwnerGate()
    sandbox = await prepareBashSandbox(ctx.cwd, ctx.sessionId)
    // 准备沙箱包含异步操作，启动子进程前再次核验会话授权与可写 inode 边界。
    assertOwnerGate()
    await sandbox.assertLaunchSafe()
    // 以独立进程组运行并接入会话中止信号：终止对整组下发，且只有在进程组确认消失后
    // 才把结果写成"已终止"，否则标记 unconfirmed。
    const run = await runBashCommand({
      argv: [...sandbox.argv, command],
      cwd: ctx.cwd,
      env: sandbox.env,
      timeout,
      abortSignal: ctx.abortSignal,
    })

    const notices: string[] = []
    const termination = describeBashTermination(run.evidence)
    if (termination) notices.push(termination)
    // 命令可能新建了仓库；收口其 hooks 与 config 可执行载体，防止注入内容在后续 git 操作中自动执行。
    try {
      const artifacts = await quarantineNewGitArtifacts(ctx.cwd, sandbox.gitWasPresent)
      if (artifacts) notices.push(artifacts)
    } catch (error) {
      notices.push(`新建仓库收口失败：${formatToolError(error)}`)
    }
    const suffix = notices.length ? `\n[Bash 沙箱] ${notices.join('；')}` : ''
    if (run.failure) {
      return {
        toolCallId: '',
        content: truncateOutput(`${run.failure.message}${suffix}`),
        isError: true,
      }
    }
    const output = run.stdout || run.stderr || '[无输出]'
    return { toolCallId: '', content: truncateOutput(`${output}${suffix}`) }
  } catch (error) {
    const message = formatToolError(error)
    // 命令失败也可能已创建仓库（如 init 后续步骤失败），同样收口。
    try {
      const hookNotice = sandbox
        ? await quarantineNewGitArtifacts(ctx.cwd, sandbox.gitWasPresent)
        : undefined
      if (hookNotice) {
        return {
          toolCallId: '',
          content: truncateOutput(`${message}\n[Bash 沙箱] ${hookNotice}`),
          isError: true,
        }
      }
    } catch {
      // 收口失败不叠加新的错误类型，原命令错误照常返回。
    }
    return {
      toolCallId: '',
      content: truncateOutput(message),
      isError: true,
    }
  }
}
