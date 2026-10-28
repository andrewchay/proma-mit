/**
 * Edit 工具实现
 *
 * 通过旧字符串替换新字符串来编辑文件。
 */

import { closeSync, constants, fstatSync, ftruncateSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ToolResult } from '@gravitas/core'
import type { ToolContext } from '../types.ts'
import { resolveToolPath, assertDescriptorMatchesStat, formatToolError, truncateOutput, requiresOwnerToolGate } from './tool-utils.ts'

export interface EditToolInput {
  file_path: string
  old_string: string
  new_string: string
}

export const EDIT_TOOL_NAME = 'Edit'

export function createEditToolDefinition() {
  return {
    name: EDIT_TOOL_NAME,
    description: '编辑文件内容。通过定位 old_string 并替换为 new_string 实现精确修改。',
    parameters: {
      type: 'object' as const,
      properties: {
        file_path: {
          type: 'string',
          description: '要编辑的文件路径，相对于当前工作目录',
        },
        old_string: {
          type: 'string',
          description: '要被替换的原文本（必须精确匹配）',
        },
        new_string: {
          type: 'string',
          description: '用于替换的新文本',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  }
}

export async function executeEditTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const params = input as EditToolInput
  const { path, error: pathError } = resolveToolPath(params.file_path, ctx.cwd)
  if (pathError) {
    return { toolCallId: '', content: pathError, isError: true }
  }

  try {
    if (requiresOwnerToolGate(ctx.sessionId, ctx.ownerWorkspaceWrite)) {
      const gates = require('../../project-owner-execution-gates') as typeof import('../../project-owner-execution-gates')
      const toolInput = input as Record<string, unknown>
      gates.assertOwnerToolWorkingDirectory(ctx.sessionId, ctx.cwd)
      gates.assertToolAllowedForSessionPurpose(ctx.sessionId, 'Edit', toolInput)
      const { consumeApprovedOwnerAction } = require('../../project-owner-action-approval') as typeof import('../../project-owner-action-approval')
      if (!consumeApprovedOwnerAction(ctx.sessionId, { toolName: 'Edit', toolInput })) throw new Error('Owner动作批准已使用或失效，请重新审批')
    }
    // 打开前固定 inode 基准，打开后比对，关闭父目录替换竞态。
    const expected = join(realpathSync(dirname(path)), basename(path))
    const before = statSync(expected)
    const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(descriptor)
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Edit拒绝符号链接、硬链接和非普通文件')
      assertDescriptorMatchesStat(descriptor, before)
      const scope = resolveToolPath(expected, ctx.cwd)
      if (scope.error) throw new Error(scope.error)
      const content = readFileSync(descriptor, 'utf-8')
      const occurrences = content.split(params.old_string).length - 1

      if (occurrences === 0) {
        return {
          toolCallId: '',
          content: `未找到要替换的文本：\n${truncateOutput(params.old_string, 500)}`,
          isError: true,
        }
      }

      if (occurrences > 1) {
        return {
          toolCallId: '',
          content: `找到 ${occurrences} 处匹配，old_string 必须唯一。请扩大上下文以精确定位。`,
          isError: true,
        }
      }

      const newContent = content.replace(params.old_string, params.new_string)
      const bytes = Buffer.from(newContent, 'utf-8')
      ftruncateSync(descriptor, 0)
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset)
        if (written === 0) throw new Error('Edit写入未完成')
        offset += written
      }
    } finally { closeSync(descriptor) }
    // PH2-A：文件共享事件流
    try {
      const { recordFileEvent } = await import('../../workspace-file-event-service')
      recordFileEvent(ctx.sessionId, 'edit', params.file_path)
    } catch {
      // 记录失败静默
    }

    return {
      toolCallId: '',
      content: `文件已编辑：${params.file_path}`,
    }
  } catch (error) {
    return {
      toolCallId: '',
      content: formatToolError(error),
      isError: true,
    }
  }
}
