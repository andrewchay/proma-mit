/**
 * Write 工具实现
 *
 * 将内容写入指定文件，若文件所在目录不存在则自动创建。
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ToolResult } from '@proma/core'
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
    const dir = dirname(path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(path, params.content, 'utf-8')
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
