/**
 * Write 工具实现
 *
 * 将内容写入指定文件，若文件所在目录不存在则自动创建。
 */

import { writeFileSync, mkdirSync, existsSync, openSync, closeSync, fstatSync, ftruncateSync, constants } from 'node:fs'
import { dirname } from 'node:path'
import type { ToolResult } from '@gravitas/core'
import type { ToolContext } from '../types.ts'
import { resolveToolPath, formatToolError } from './tool-utils.ts'

export interface WriteToolInput {
  file_path: string
  content: string
}

export const WRITE_TOOL_NAME = 'Write'

export function createWriteToolDefinition() {
  return {
    name: WRITE_TOOL_NAME,
    description: '将内容写入指定文件。若文件已存在则覆盖；若目录不存在则自动创建。',
    parameters: {
      type: 'object' as const,
      properties: {
        file_path: {
          type: 'string',
          description: '要写入的文件路径，相对于当前工作目录',
        },
        content: {
          type: 'string',
          description: '要写入的文件内容',
        },
      },
      required: ['file_path', 'content'],
    },
  }
}

export async function executeWriteTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const params = input as WriteToolInput
  const { path, error: pathError } = resolveToolPath(params.file_path, ctx.cwd)
  if (pathError) {
    return { toolCallId: '', content: pathError, isError: true }
  }

  try {
    let exclusiveCreate = false
    if (ctx.ownerWorkspaceWrite) {
      const gates = require('../../project-owner-execution-gates') as typeof import('../../project-owner-execution-gates')
      gates.assertOwnerToolWorkingDirectory(ctx.sessionId, ctx.cwd)
      gates.assertToolAllowedForSessionPurpose(ctx.sessionId, 'Write', { file_path: params.file_path, content: params.content })
      exclusiveCreate = gates.isOwnerAutoAllowedWorkspaceWrite(ctx.sessionId, 'Write', { file_path: params.file_path, content: params.content })
      if (!exclusiveCreate) {
        const { consumeApprovedOwnerAction } = require('../../project-owner-action-approval') as typeof import('../../project-owner-action-approval')
        if (!consumeApprovedOwnerAction(ctx.sessionId, { toolName: 'Write', toolInput: { file_path: params.file_path, content: params.content } })) throw new Error('Owner动作批准已使用或失效，请重新审批')
      }
    }
    const dir = dirname(path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    // 新建必须独占；已存在文件先打开再核验，不能在核验前截断链接目标。
    let descriptor: number
    try {
      descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if (exclusiveCreate) throw error
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      descriptor = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    }
    try {
      const stat = fstatSync(descriptor)
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Write拒绝符号链接、硬链接和非普通文件')
      // 打开后再次检查父路径，缩小检查与使用窗口；这不是跨进程文件系统沙箱。
      const recheck = resolveToolPath(params.file_path, ctx.cwd)
      if (recheck.error) throw new Error(recheck.error)
      ftruncateSync(descriptor, 0)
      writeFileSync(descriptor, params.content, 'utf-8')
    } finally { closeSync(descriptor) }
    // PH2-A：文件共享事件流（谁改了什么，团队成员可见）
    try {
      const { recordFileEvent } = await import('../../workspace-file-event-service')
      recordFileEvent(ctx.sessionId, 'write', params.file_path)
    } catch {
      // 记录失败静默
    }
    return {
      toolCallId: '',
      content: `文件已写入：${params.file_path}`,
    }
  } catch (error) {
    return {
      toolCallId: '',
      content: formatToolError(error),
      isError: true,
    }
  }
}
