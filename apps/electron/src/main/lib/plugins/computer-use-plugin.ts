/**
 * Computer Use 插件（com.gravitas.computer-use）
 *
 * 把系统级 Computer Use 工具族（截图/点击/输入/滚动/拖拽等）以「插件贡献 agent-tools」
 * 的方式提供，替代原先在 tool-registry 中的硬编码注册。
 *
 * 分层语义：
 * - manifest.permissions.computerUse 是本插件「声明的能力上限」（分档）；
 * - 注册期是否贡献工具由 isEnabled() + isSupported()(darwin) 决定；
 * - 实际逐次放行由宿主权限服务 + 宿主 computerUse 分档门控决定（阶段 C）。
 */

import type { RuntimeToolDefinition } from '../agent-runtime/types'
import {
  COMPUTER_USE_CAPABILITIES_TOOL_NAME,
  COMPUTER_USE_CLICK_TOOL_NAME,
  COMPUTER_USE_DISPLAYS_TOOL_NAME,
  COMPUTER_USE_DOUBLE_CLICK_TOOL_NAME,
  COMPUTER_USE_DRAG_TOOL_NAME,
  COMPUTER_USE_FRONTMOST_APPLICATION_TOOL_NAME,
  COMPUTER_USE_FRONTMOST_WINDOW_TOOL_NAME,
  COMPUTER_USE_KEY_COMBO_TOOL_NAME,
  COMPUTER_USE_MOVE_TOOL_NAME,
  COMPUTER_USE_REQUEST_PERMISSIONS_TOOL_NAME,
  COMPUTER_USE_REQUEST_TAKEOVER_TOOL_NAME,
  COMPUTER_USE_SCREENSHOT_TOOL_NAME,
  COMPUTER_USE_SCROLL_TOOL_NAME,
  COMPUTER_USE_STATUS_TOOL_NAME,
  COMPUTER_USE_TYPE_TOOL_NAME,
  createComputerUseCapabilitiesToolDefinition,
  createComputerUseClickToolDefinition,
  createComputerUseDisplaysToolDefinition,
  createComputerUseDoubleClickToolDefinition,
  createComputerUseDragToolDefinition,
  createComputerUseFrontmostApplicationToolDefinition,
  createComputerUseFrontmostWindowToolDefinition,
  createComputerUseKeyComboToolDefinition,
  createComputerUseMoveToolDefinition,
  createComputerUseRequestPermissionsToolDefinition,
  createComputerUseRequestTakeoverToolDefinition,
  createComputerUseScreenshotToolDefinition,
  createComputerUseScrollToolDefinition,
  createComputerUseStatusToolDefinition,
  createComputerUseTypeToolDefinition,
  executeComputerUseCapabilitiesTool,
  executeComputerUseClickTool,
  executeComputerUseDisplaysTool,
  executeComputerUseDoubleClickTool,
  executeComputerUseDragTool,
  executeComputerUseFrontmostApplicationTool,
  executeComputerUseFrontmostWindowTool,
  executeComputerUseKeyComboTool,
  executeComputerUseMoveTool,
  executeComputerUseRequestPermissionsTool,
  executeComputerUseRequestTakeoverTool,
  executeComputerUseScreenshotTool,
  executeComputerUseScrollTool,
  executeComputerUseStatusTool,
  executeComputerUseTypeTool,
} from '../agent-runtime/tool-impls/computer-use-tools'
import type { BuiltinPluginRuntime } from '../plugin-manager'

/** Computer Use 只读子集（分档 readOnly 时仅贡献/放行这些） */
export const COMPUTER_USE_READONLY_TOOL_NAMES: readonly string[] = [
  COMPUTER_USE_STATUS_TOOL_NAME,
  COMPUTER_USE_CAPABILITIES_TOOL_NAME,
  COMPUTER_USE_FRONTMOST_APPLICATION_TOOL_NAME,
  COMPUTER_USE_FRONTMOST_WINDOW_TOOL_NAME,
  COMPUTER_USE_DISPLAYS_TOOL_NAME,
]

/** Computer Use 写操作子集（分档 allowWrite 时放行） */
export const COMPUTER_USE_WRITE_TOOL_NAMES: readonly string[] = [
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

/** Computer Use 全部工具定义（含只读 + 权限 + 写操作） */
function allComputerUseToolDefinitions(): RuntimeToolDefinition[] {
  return [
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
}

/** 仅只读子集（分档 readOnly 时提供） */
function readOnlyToolDefinitions(): RuntimeToolDefinition[] {
  return allComputerUseToolDefinitions().filter((tool) => COMPUTER_USE_READONLY_TOOL_NAMES.includes(tool.name))
}

/** Computer Use 插件运行时（作为内置插件被 plugin-manager 管理） */
export function computerUsePluginRuntime(): BuiltinPluginRuntime {
  return {
    manifest: {
      schemaVersion: 1,
      id: 'com.gravitas.computer-use',
      version: '1.0.0',
      name: 'Computer Use',
      description: '提供系统级桌面控制（截图/点击/输入/滚动/拖拽）与计算机状态读取工具',
      publisher: 'Proma',
      platforms: ['darwin'],
      activationEvents: ['onAppReady'],
      subscriptions: [],
      surfaces: ['agent-tools', 'settings'],
      permissions: {
        // 声明能力上限：本插件提供完整的 Computer Use 工具（含读写）。
        // 实际运行时启用级别由宿主 computerUse 分档配置（settings）进一步收紧。
        computerUse: { enabled: true, readOnly: true, allowWrite: true },
      },
      entrypoints: {},
    },
    isEnabled: () => getHostComputerUseConfig().enabled,
    setEnabled: async (enabled) => {
      const current = getHostComputerUseConfig()
      setHostComputerUseConfig({ enabled })
      return current.enabled !== enabled
    },
    isSupported: () => process.platform === 'darwin',
    // 按宿主分档配置裁剪贡献的工具：enabled=false 不贡献；readOnlyOnly 只贡献只读子集。
    contributeTools: () => {
      const host = getHostComputerUseConfig()
      if (!host.enabled) return []
      const all = allComputerUseToolDefinitions()
      if (host.readOnlyOnly) return readOnlyToolDefinitions()
      return all
    },
  }
}

/** 读取宿主 Computer Use 分档配置（settings）；缺省 enabled=true 保持历史行为。 */
function getHostComputerUseConfig(): { enabled: boolean; readOnlyOnly: boolean } {
  try {
    // 延迟 require 避免循环依赖
    const { getSettings } = require('../settings-service') as { getSettings: () => { computerUse?: { enabled?: boolean; readOnlyOnly?: boolean } } }
    const cfg = getSettings().computerUse
    return { enabled: cfg?.enabled ?? true, readOnlyOnly: cfg?.readOnlyOnly ?? false }
  } catch {
    return { enabled: true, readOnlyOnly: false }
  }
}

/** 写入宿主 Computer Use 分档配置（settings）。返回成功与否。 */
function setHostComputerUseConfig(updates: { enabled?: boolean; readOnlyOnly?: boolean }): boolean {
  try {
    const { getSettings, updateSettings } = require('../settings-service') as {
      getSettings: () => { computerUse?: Record<string, unknown> }
      updateSettings: (u: { computerUse?: Record<string, unknown> }) => unknown
    }
    const current = getSettings().computerUse ?? {}
    updateSettings({ computerUse: { ...current, ...updates } })
    return true
  } catch {
    return false
  }
}
