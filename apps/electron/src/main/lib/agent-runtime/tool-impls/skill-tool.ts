/**
 * ReadSkill 工具实现
 *
 * 读取当前工作区指定 Skill 的文件内容（默认 SKILL.md）。
 *
 * 安全：复用 agent-workspace-manager 的 readSkillFile —— 内置路径逃逸防护、
 * SKILL.md 专用接口保护与 10MB 大小限制，工具本身只读、无写入能力。
 *
 * 使用约定（写入系统提示词）：
 * - 使用 Skill 前必须先调用 ReadSkill 读取完整 SKILL.md
 * - skill_slug 用工作区已启用的 Skill 标识（<available_skills> 清单）
 */

import type { ToolResult } from '@proma/core'
import type { ToolContext } from '../types.ts'
import { readSkillFile } from '../../agent-workspace-manager'
import { formatToolError, truncateOutput } from './tool-utils.ts'

export interface ReadSkillToolInput {
  skill_slug: string
  /** 相对 Skill 根目录的文件路径；缺省为 SKILL.md */
  file_path?: string
}

export const READ_SKILL_TOOL_NAME = 'ReadSkill'

export function createSkillToolDefinition() {
  return {
    name: READ_SKILL_TOOL_NAME,
    description:
      '读取当前工作区中指定 Skill 的文件内容。Skill 是封装了可复用方法/流程的文档（根目录有 SKILL.md，可能附带参考脚本或模板）。调用 Skill 前必须先读取 SKILL.md 全文。可传入 file_path 读取 Skill 目录下的子文件（如参考模板）。',
    parameters: {
      type: 'object' as const,
      properties: {
        skill_slug: {
          type: 'string',
          description: '要读取的 Skill 标识（slug），来自系统提示词中的 available_skills 清单',
        },
        file_path: {
          type: 'string',
          description: '相对 Skill 根目录的文件路径，缺省读取 SKILL.md',
        },
      },
      required: ['skill_slug'],
    },
  }
}

export async function executeSkillTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const params = input as ReadSkillToolInput

  if (!ctx.workspaceSlug) {
    return {
      toolCallId: '',
      content: '当前会话没有绑定工作区，无法读取 Skill。请先在工作区中创建或选择 Skill。',
      isError: true,
    }
  }

  const skillSlug = params.skill_slug?.trim()
  if (!skillSlug) {
    return { toolCallId: '', content: 'skill_slug 不能为空', isError: true }
  }

  const filePath = params.file_path?.trim() || 'SKILL.md'

  try {
    // ReadSkill 的用途正是读取 SKILL.md 全文（默认），需允许该专用文件；子文件同样允许。
    const result = readSkillFile(ctx.workspaceSlug, skillSlug, filePath, { allowSkillMd: true })
    if (!result.isText) {
      return {
        toolCallId: '',
        content: `文件 ${result.relativePath} 不是文本文件，无法读取内容。`,
        isError: true,
      }
    }
    return {
      toolCallId: '',
      content: truncateOutput(result.content ?? ''),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      toolCallId: '',
      content: `读取 Skill 失败：${message}`,
      isError: true,
    }
  }
}
