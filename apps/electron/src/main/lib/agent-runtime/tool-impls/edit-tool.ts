/**
 * Edit 工具实现
 *
 * 通过旧字符串替换新字符串来编辑文件。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import type { ToolResult } from '@proma/core'
import type { ToolContext } from '../types.ts'
import { resolveToolPath, formatToolError, truncateOutput } from './tool-utils.ts'

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
    const content = readFileSync(path, 'utf-8')
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
    writeFileSync(path, newContent, 'utf-8')

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
