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
import {
  TODO_CONTEXT_TOOL_NAME,
  createTodoContextToolDefinition,
  executeTodoContextTool,
} from './tool-impls/todo-context-tool.ts'
import {
  COST_AUDIT_TOOL_NAME,
  createCostAuditToolDefinition,
  executeCostAuditTool,
} from './tool-impls/cost-audit-tool.ts'
import {
  PROPOSE_ASSET_TOOL_NAME,
  createProposeAssetToolDefinition,
  executeProposeAssetTool,
} from './tool-impls/asset-proposal-tool.ts'
import {
  AGENT_TOOL_NAME,
  createAgentToolDefinition,
  executeAgentTool,
} from './tool-impls/agent-tool.ts'
import {
  LIST_MCP_RESOURCES_TOOL_NAME,
  READ_MCP_RESOURCE_TOOL_NAME,
  createListMcpResourcesToolDefinition,
  createReadMcpResourceToolDefinition,
} from './tool-impls/mcp-resource-tools.ts'
import {
  WEB_BRIDGE_NAVIGATE_TOOL_NAME,
  WEB_BRIDGE_SNAPSHOT_TOOL_NAME,
  WEB_BRIDGE_SCREENSHOT_TOOL_NAME,
  WEB_BRIDGE_CLICK_TOOL_NAME,
  WEB_BRIDGE_TYPE_TOOL_NAME,
  WEB_BRIDGE_SCROLL_TOOL_NAME,
  WEB_BRIDGE_CHROME_TARGETS_TOOL_NAME,
  WEB_BRIDGE_CONNECT_CHROME_TOOL_NAME,
  WEB_BRIDGE_DOWNLOAD_TOOL_NAME,
  WEB_BRIDGE_UPLOAD_TOOL_NAME,
  WEB_BRIDGE_STATUS_TOOL_NAME,
  WEB_BRIDGE_STOP_TOOL_NAME,
  createWebBridgeNavigateToolDefinition,
  createWebBridgeSnapshotToolDefinition,
  createWebBridgeScreenshotToolDefinition,
  createWebBridgeClickToolDefinition,
  createWebBridgeTypeToolDefinition,
  createWebBridgeScrollToolDefinition,
  createWebBridgeChromeTargetsToolDefinition,
  createWebBridgeConnectChromeToolDefinition,
  createWebBridgeDownloadToolDefinition,
  createWebBridgeUploadToolDefinition,
  createWebBridgeStatusToolDefinition,
  createWebBridgeStopToolDefinition,
  executeWebBridgeNavigateTool,
  executeWebBridgeSnapshotTool,
  executeWebBridgeScreenshotTool,
  executeWebBridgeClickTool,
  executeWebBridgeTypeTool,
  executeWebBridgeScrollTool,
  executeWebBridgeChromeTargetsTool,
  executeWebBridgeConnectChromeTool,
  executeWebBridgeDownloadTool,
  executeWebBridgeUploadTool,
  executeWebBridgeStatusTool,
  executeWebBridgeStopTool,
} from './tool-impls/web-bridge-tools.ts'
import {
  COMPUTER_USE_STATUS_TOOL_NAME,
  COMPUTER_USE_CAPABILITIES_TOOL_NAME,
  COMPUTER_USE_FRONTMOST_APPLICATION_TOOL_NAME,
  COMPUTER_USE_FRONTMOST_WINDOW_TOOL_NAME,
  COMPUTER_USE_DISPLAYS_TOOL_NAME,
  COMPUTER_USE_REQUEST_PERMISSIONS_TOOL_NAME,
  COMPUTER_USE_SCREENSHOT_TOOL_NAME,
  COMPUTER_USE_CLICK_TOOL_NAME,
  COMPUTER_USE_MOVE_TOOL_NAME,
  COMPUTER_USE_DOUBLE_CLICK_TOOL_NAME,
  COMPUTER_USE_TYPE_TOOL_NAME,
  COMPUTER_USE_SCROLL_TOOL_NAME,
  COMPUTER_USE_DRAG_TOOL_NAME,
  COMPUTER_USE_KEY_COMBO_TOOL_NAME,
  COMPUTER_USE_REQUEST_TAKEOVER_TOOL_NAME,
  createComputerUseStatusToolDefinition,
  createComputerUseCapabilitiesToolDefinition,
  createComputerUseFrontmostApplicationToolDefinition,
  createComputerUseFrontmostWindowToolDefinition,
  createComputerUseDisplaysToolDefinition,
  createComputerUseRequestPermissionsToolDefinition,
  createComputerUseScreenshotToolDefinition,
  createComputerUseClickToolDefinition,
  createComputerUseMoveToolDefinition,
  createComputerUseDoubleClickToolDefinition,
  createComputerUseTypeToolDefinition,
  createComputerUseScrollToolDefinition,
  createComputerUseDragToolDefinition,
  createComputerUseKeyComboToolDefinition,
  createComputerUseRequestTakeoverToolDefinition,
  executeComputerUseStatusTool,
  executeComputerUseCapabilitiesTool,
  executeComputerUseFrontmostApplicationTool,
  executeComputerUseFrontmostWindowTool,
  executeComputerUseDisplaysTool,
  executeComputerUseRequestPermissionsTool,
  executeComputerUseScreenshotTool,
  executeComputerUseClickTool,
  executeComputerUseMoveTool,
  executeComputerUseDoubleClickTool,
  executeComputerUseTypeTool,
  executeComputerUseScrollTool,
  executeComputerUseDragTool,
  executeComputerUseKeyComboTool,
  executeComputerUseRequestTakeoverTool,
} from './tool-impls/computer-use-tools.ts'
import { WEB_SEARCH_TOOL_NAME, createWebSearchToolDefinition, executeWebSearchTool } from './tool-impls/web-search-tool.ts'
import { WEB_FETCH_TOOL_NAME, createWebFetchToolDefinition, executeWebFetchTool } from './tool-impls/web-fetch-tool.ts'
import { RECALL_MEMORY_TOOL_NAME, ADD_MEMORY_TOOL_NAME, createRecallMemoryToolDefinition, createAddMemoryToolDefinition, executeRecallMemoryTool, executeAddMemoryTool } from './tool-impls/memory-tool.ts'
import { COMPACT_CONTEXT_TOOL_NAME, createCompactContextToolDefinition } from './context-compaction'
import { GOAL_CHECKPOINT_TOOL_NAME, createGoalCheckpointToolDefinition } from './tool-impls/goal-checkpoint-tool.ts'
import { READ_SKILL_TOOL_NAME, createSkillToolDefinition, executeSkillTool } from './tool-impls/skill-tool.ts'
export { ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME, AGENT_TOOL_NAME, GOAL_CHECKPOINT_TOOL_NAME, READ_SKILL_TOOL_NAME, TODO_CONTEXT_TOOL_NAME, COST_AUDIT_TOOL_NAME, PROPOSE_ASSET_TOOL_NAME }
export { LIST_MCP_RESOURCES_TOOL_NAME, READ_MCP_RESOURCE_TOOL_NAME }

/** 核心工具注册选项 */
export interface CreateCoreToolsOptions {
  /** 当前工作区 slug；有工作区时才注册 ReadSkill 工具 */
  workspaceSlug?: string
}

/** 阶段 1 核心工具列表 */
export function createCoreTools(options?: CreateCoreToolsOptions): RuntimeToolDefinition[] {
  const tools: RuntimeToolDefinition[] = [
    { ...createReadToolDefinition(), execute: executeReadTool },
    { ...createWriteToolDefinition(), execute: executeWriteTool },
    { ...createEditToolDefinition(), execute: executeEditTool },
    { ...createBashToolDefinition(), execute: executeBashTool },
    { ...createGrepToolDefinition(), execute: executeGrepTool },
    { ...createWebSearchToolDefinition(), execute: executeWebSearchTool },
    { ...createWebFetchToolDefinition(), execute: executeWebFetchTool },
    { ...createRecallMemoryToolDefinition(), execute: executeRecallMemoryTool },
    { ...createAddMemoryToolDefinition(), execute: executeAddMemoryTool },
    createCompactContextToolDefinition(),
    createEnterPlanModeToolDefinition(),
    createExitPlanModeToolDefinition(),
    { ...createAskUserQuestionToolDefinition(), execute: executeAskUserQuestionTool },
    { ...createAgentToolDefinition(), execute: executeAgentTool },
    createListMcpResourcesToolDefinition(),
    createReadMcpResourceToolDefinition(),
    createGoalCheckpointToolDefinition(),
    { ...createWebBridgeNavigateToolDefinition(), execute: executeWebBridgeNavigateTool },
    { ...createWebBridgeSnapshotToolDefinition(), execute: executeWebBridgeSnapshotTool },
    { ...createWebBridgeScreenshotToolDefinition(), execute: executeWebBridgeScreenshotTool },
    { ...createWebBridgeClickToolDefinition(), execute: executeWebBridgeClickTool },
    { ...createWebBridgeTypeToolDefinition(), execute: executeWebBridgeTypeTool },
    { ...createWebBridgeScrollToolDefinition(), execute: executeWebBridgeScrollTool },
    { ...createWebBridgeChromeTargetsToolDefinition(), execute: executeWebBridgeChromeTargetsTool },
    { ...createWebBridgeConnectChromeToolDefinition(), execute: executeWebBridgeConnectChromeTool },
    { ...createWebBridgeDownloadToolDefinition(), execute: executeWebBridgeDownloadTool },
    { ...createWebBridgeUploadToolDefinition(), execute: executeWebBridgeUploadTool },
    { ...createWebBridgeStatusToolDefinition(), execute: executeWebBridgeStatusTool },
    { ...createWebBridgeStopToolDefinition(), execute: executeWebBridgeStopTool },
    { ...createComputerUseStatusToolDefinition(), execute: executeComputerUseStatusTool },
    { ...createComputerUseCapabilitiesToolDefinition(), execute: executeComputerUseCapabilitiesTool },
    { ...createComputerUseFrontmostApplicationToolDefinition(), execute: executeComputerUseFrontmostApplicationTool },
    { ...createComputerUseFrontmostWindowToolDefinition(), execute: executeComputerUseFrontmostWindowTool },
    { ...createComputerUseDisplaysToolDefinition(), execute: executeComputerUseDisplaysTool },
    { ...createComputerUseRequestPermissionsToolDefinition(), execute: executeComputerUseRequestPermissionsTool },
    { ...createComputerUseScreenshotToolDefinition(), execute: executeComputerUseScreenshotTool },
    { ...createComputerUseClickToolDefinition(), execute: executeComputerUseClickTool },
    { ...createComputerUseMoveToolDefinition(), execute: executeComputerUseMoveTool },
    { ...createComputerUseDoubleClickToolDefinition(), execute: executeComputerUseDoubleClickTool },
    { ...createComputerUseTypeToolDefinition(), execute: executeComputerUseTypeTool },
    { ...createComputerUseScrollToolDefinition(), execute: executeComputerUseScrollTool },
    { ...createComputerUseDragToolDefinition(), execute: executeComputerUseDragTool },
    { ...createComputerUseKeyComboToolDefinition(), execute: executeComputerUseKeyComboTool },
    { ...createComputerUseRequestTakeoverToolDefinition(), execute: executeComputerUseRequestTakeoverTool },
  ]

  // 有工作区时才注册 ReadSkill：无工作区会话没有可读的 Skill，避免暴露无用工具
  if (options?.workspaceSlug) {
    tools.push({ ...createSkillToolDefinition(), execute: executeSkillTool })
  }

  // PH2-A：Todo 解压缩工具（Agent 可解释队友的待办）
  tools.push({ ...createTodoContextToolDefinition(), execute: executeTodoContextTool })

  // PH2-C：费用审计工具（Agent 可自动/按需审计费用）
  tools.push({ ...createCostAuditToolDefinition(), execute: executeCostAuditTool })

  // PH2-D：成功输出转可复用资产提案
  tools.push({ ...createProposeAssetToolDefinition(), execute: executeProposeAssetTool })

  return tools
}

/** 工具名称集合（用于白名单校验） */
export const CORE_TOOL_NAMES: readonly string[] = [
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
  EDIT_TOOL_NAME,
  BASH_TOOL_NAME,
  GREP_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  RECALL_MEMORY_TOOL_NAME,
  ADD_MEMORY_TOOL_NAME,
  COMPACT_CONTEXT_TOOL_NAME,
  READ_SKILL_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  AGENT_TOOL_NAME,
  LIST_MCP_RESOURCES_TOOL_NAME,
  READ_MCP_RESOURCE_TOOL_NAME,
  GOAL_CHECKPOINT_TOOL_NAME,
  TODO_CONTEXT_TOOL_NAME,
  COST_AUDIT_TOOL_NAME,
  PROPOSE_ASSET_TOOL_NAME,
  WEB_BRIDGE_NAVIGATE_TOOL_NAME,
  WEB_BRIDGE_SNAPSHOT_TOOL_NAME,
  WEB_BRIDGE_SCREENSHOT_TOOL_NAME,
  WEB_BRIDGE_CLICK_TOOL_NAME,
  WEB_BRIDGE_TYPE_TOOL_NAME,
  WEB_BRIDGE_SCROLL_TOOL_NAME,
  WEB_BRIDGE_CHROME_TARGETS_TOOL_NAME,
  WEB_BRIDGE_CONNECT_CHROME_TOOL_NAME,
  WEB_BRIDGE_DOWNLOAD_TOOL_NAME,
  WEB_BRIDGE_STATUS_TOOL_NAME,
  WEB_BRIDGE_STOP_TOOL_NAME,
  COMPUTER_USE_STATUS_TOOL_NAME,
  COMPUTER_USE_CAPABILITIES_TOOL_NAME,
  COMPUTER_USE_FRONTMOST_APPLICATION_TOOL_NAME,
  COMPUTER_USE_FRONTMOST_WINDOW_TOOL_NAME,
  COMPUTER_USE_DISPLAYS_TOOL_NAME,
  COMPUTER_USE_REQUEST_PERMISSIONS_TOOL_NAME,
  COMPUTER_USE_SCREENSHOT_TOOL_NAME,
  COMPUTER_USE_CLICK_TOOL_NAME,
  COMPUTER_USE_MOVE_TOOL_NAME,
  COMPUTER_USE_DOUBLE_CLICK_TOOL_NAME,
  COMPUTER_USE_TYPE_TOOL_NAME,
  COMPUTER_USE_SCROLL_TOOL_NAME,
  COMPUTER_USE_DRAG_TOOL_NAME,
  COMPUTER_USE_KEY_COMBO_TOOL_NAME,
  COMPUTER_USE_REQUEST_TAKEOVER_TOOL_NAME,
]

/**
 * 判断是否为阶段 1 支持的核心工具
 */
export function isCoreTool(name: string): boolean {
  return CORE_TOOL_NAMES.includes(name)
}
