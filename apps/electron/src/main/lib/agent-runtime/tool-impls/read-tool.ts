/**
 * Read 工具实现
 *
 * 读取指定文件内容，支持偏移和行数限制。
 */

import { readFileSync } from 'node:fs'
import type { ToolResult } from '@proma/core'
import type { ToolContext } from '../types.ts'
import { resolveToolPath, formatToolError, truncateOutput } from './tool-utils.ts'

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
    const content = readFileSync(path, 'utf-8')
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
