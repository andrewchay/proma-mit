/**
 * Agent Runtime 工具注册表
 *
 * 阶段 1 仅提供 5 个核心内置工具：Read、Write、Edit、Bash、Grep。
 * 未来可在此扩展 MCP 工具、Memory 工具、Feishu 工具等。
 */

import type { RuntimeToolDefinition } from './types.ts'
import {
  READ_TOOL_NAME,
  createReadToolDefinition,
  executeReadTool,
} from './tool-impls/read-tool.ts'
import {
  WRITE_TOOL_NAME,
  createWriteToolDefinition,
  executeWriteTool,
} from './tool-impls/write-tool.ts'
import {
  EDIT_TOOL_NAME,
  createEditToolDefinition,
  executeEditTool,
} from './tool-impls/edit-tool.ts'
import {
  BASH_TOOL_NAME,
  createBashToolDefinition,
  executeBashTool,
} from './tool-impls/bash-tool.ts'
import {
  GREP_TOOL_NAME,
  createGrepToolDefinition,
  executeGrepTool,
} from './tool-impls/grep-tool.ts'
import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  createEnterPlanModeToolDefinition,
  createExitPlanModeToolDefinition,
} from './tool-impls/plan-mode-tools.ts'
import {
  ASK_USER_QUESTION_TOOL_NAME,
  createAskUserQuestionToolDefinition,
  executeAskUserQuestionTool,
} from './tool-impls/ask-user-tool.ts'
export { ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME }

/** 阶段 1 核心工具列表 */
export function createCoreTools(): RuntimeToolDefinition[] {
  return [
    { ...createReadToolDefinition(), execute: executeReadTool },
    { ...createWriteToolDefinition(), execute: executeWriteTool },
    { ...createEditToolDefinition(), execute: executeEditTool },
    { ...createBashToolDefinition(), execute: executeBashTool },
    { ...createGrepToolDefinition(), execute: executeGrepTool },
    createEnterPlanModeToolDefinition(),
    createExitPlanModeToolDefinition(),
    { ...createAskUserQuestionToolDefinition(), execute: executeAskUserQuestionTool },
  ]
}

/** 工具名称集合（用于白名单校验） */
export const CORE_TOOL_NAMES: readonly string[] = [
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
  EDIT_TOOL_NAME,
  BASH_TOOL_NAME,
  GREP_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
]

/**
 * 判断是否为阶段 1 支持的核心工具
 */
export function isCoreTool(name: string): boolean {
  return CORE_TOOL_NAMES.includes(name)
}
