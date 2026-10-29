/**
 * Read 工具实现
 *
 * 读取指定文件内容，支持偏移和行数限制。
 */

import { closeSync, constants, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
import type { ToolResult } from '@gravitas/core'
import type { ToolContext } from '../types.ts'
import { resolveToolPath, assertDescriptorMatchesStat, formatToolError, truncateOutput, requiresOwnerToolGate } from './tool-utils.ts'

export interface ReadToolInput {
  file_path: string
  offset?: number
  limit?: number
}

export const READ_TOOL_NAME = 'Read'

export function createReadToolDefinition() {
  return {
    name: READ_TOOL_NAME,
    description: '读取指定文件的内容。对于大文件，建议先用 offset/limit 分段读取。',
    parameters: {
      type: 'object' as const,
      properties: {
        file_path: {
          type: 'string',
          description: '要读取的文件路径，相对于当前工作目录',
        },
        offset: {
          type: 'number',
          description: '起始行号（从 0 开始，可选）',
        },
        limit: {
          type: 'number',
          description: '最多读取行数（可选）',
        },
      },
      required: ['file_path'],
    },
  }
}

export async function executeReadTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const params = input as ReadToolInput
  const { path, error: pathError } = resolveToolPath(params.file_path, ctx.cwd)
  if (pathError) {
    return { toolCallId: '', content: pathError, isError: true }
  }

  try {
    if (requiresOwnerToolGate(ctx.sessionId, ctx.ownerWorkspaceWrite)) {
      const gates = require('../../project-owner-execution-gates') as typeof import('../../project-owner-execution-gates')
      gates.assertOwnerToolWorkingDirectory(ctx.sessionId, ctx.cwd)
      gates.assertToolAllowedForSessionPurpose(ctx.sessionId, 'Read', { file_path: params.file_path, offset: params.offset, limit: params.limit })
    }
    // 打开前重解析真实路径并固定 inode 基准，打开后比对，关闭父目录替换竞态。
    const expected = realpathSync(path)
    const before = statSync(expected)
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    let content: string
    try {
      assertDescriptorMatchesStat(descriptor, before)
      const scope = resolveToolPath(expected, ctx.cwd)
      if (scope.error) throw new Error(scope.error)
      content = readFileSync(descriptor, 'utf-8')
    } finally {
      closeSync(descriptor)
    }
    const lines = content.split('\n')
    const offset = params.offset ?? 0
    const limit = params.limit ?? lines.length
    const sliced = lines.slice(offset, offset + limit)

    const result = sliced.join('\n')
    return {
      toolCallId: '',
      content: truncateOutput(result),
    }
  } catch (error) {
    return {
      toolCallId: '',
      content: formatToolError(error),
      isError: true,
    }
  }
}
