/** 系统级 Computer Use 工具。所有桌面读取和控制均需要用户明确授权。 */

import type { ToolResult } from '@gravitas/core'
import { appendComputerUseAudit } from '../../computer-use-audit-service'
import { computerUseService } from '../../computer-use-service'
import { webBridgeService } from '../../web-bridge-service'
import type { ToolContext } from '../types'
import { describeDesktopActionFailure } from './computer-use-outcome'
import {
  blockIfUnknownAction,
  buildActionKey,
  hashDetail,
  recordUnknownAction,
} from '../unknown-action-store'
import { guardOwnerTool } from './tool-utils'

export const COMPUTER_USE_STATUS_TOOL_NAME = 'ComputerUseStatus'
export const COMPUTER_USE_CAPABILITIES_TOOL_NAME = 'ComputerUseCapabilities'
export const COMPUTER_USE_FRONTMOST_APPLICATION_TOOL_NAME = 'ComputerUseFrontmostApplication'
export const COMPUTER_USE_FRONTMOST_WINDOW_TOOL_NAME = 'ComputerUseFrontmostWindow'
export const COMPUTER_USE_DISPLAYS_TOOL_NAME = 'ComputerUseDisplays'
export const COMPUTER_USE_REQUEST_PERMISSIONS_TOOL_NAME = 'ComputerUseRequestPermissions'
export const COMPUTER_USE_SCREENSHOT_TOOL_NAME = 'ComputerUseScreenshot'
export const COMPUTER_USE_CLICK_TOOL_NAME = 'ComputerUseClick'
export const COMPUTER_USE_MOVE_TOOL_NAME = 'ComputerUseMove'
export const COMPUTER_USE_DOUBLE_CLICK_TOOL_NAME = 'ComputerUseDoubleClick'
export const COMPUTER_USE_TYPE_TOOL_NAME = 'ComputerUseType'
export const COMPUTER_USE_SCROLL_TOOL_NAME = 'ComputerUseScroll'
export const COMPUTER_USE_DRAG_TOOL_NAME = 'ComputerUseDrag'
export const COMPUTER_USE_KEY_COMBO_TOOL_NAME = 'ComputerUseKeyCombo'
export const COMPUTER_USE_REQUEST_TAKEOVER_TOOL_NAME = 'ComputerUseRequestTakeover'

const DISPLAY_COORDINATE_PROPERTIES = {
  display_id: { type: 'string', description: 'ComputerUseScreenshot 或 ComputerUseDisplays 返回的显示器 ID，可选' },
  coordinate_scale: { type: 'number', description: 'ComputerUseScreenshot 返回的 coordinateScale；传入截图像素坐标时必须原样带回，可选' },
}

export function createComputerUseStatusToolDefinition() {
  return definition(COMPUTER_USE_STATUS_TOOL_NAME, '读取 Proma 的 macOS Computer Use 授权状态，不读取屏幕内容，也不控制桌面。')
}

export function createComputerUseCapabilitiesToolDefinition() {
  return definition(COMPUTER_USE_CAPABILITIES_TOOL_NAME, '读取当前平台的 Computer Use 能力与降级状态，不读取屏幕内容。')
}

export function createComputerUseFrontmostApplicationToolDefinition() {
  return definition(COMPUTER_USE_FRONTMOST_APPLICATION_TOOL_NAME, '读取当前 macOS 前台应用的名称、bundle ID 和进程 ID，不读取窗口内容，也不控制桌面。')
}

export function createComputerUseFrontmostWindowToolDefinition() {
  return definition(COMPUTER_USE_FRONTMOST_WINDOW_TOOL_NAME, '读取当前 macOS 聚焦窗口的标题和位置尺寸，不读取窗口内容。')
}

export function createComputerUseDisplaysToolDefinition() {
  return definition(COMPUTER_USE_DISPLAYS_TOOL_NAME, '列出可供 Computer Use 操作的显示器及其逻辑坐标范围，不读取屏幕内容。')
}

export function createComputerUseRequestPermissionsToolDefinition() {
  return definition(COMPUTER_USE_REQUEST_PERMISSIONS_TOOL_NAME, '请求 macOS 辅助功能和屏幕录制授权。该操作会打开系统授权提示，必须由用户自行确认。')
}

export function createComputerUseScreenshotToolDefinition() {
  return {
    name: COMPUTER_USE_SCREENSHOT_TOOL_NAME,
    description: '截取指定显示器当前画面；未指定时截取主显示器。屏幕可能含有敏感信息，因此每次获取截图前都必须请求用户授权。',
    parameters: { type: 'object' as const, properties: { display_id: DISPLAY_COORDINATE_PROPERTIES.display_id } },
  }
}

export function createComputerUseClickToolDefinition() {
  return pointDefinition(COMPUTER_USE_CLICK_TOOL_NAME, '在指定显示器的坐标点击。截图坐标必须同时传 coordinate_scale；点击提交、购买、删除、发布、授权或安全设置前，必须向用户说明后果并确认。')
}

export function createComputerUseMoveToolDefinition() {
  return pointDefinition(COMPUTER_USE_MOVE_TOOL_NAME, '将鼠标移动到指定显示器的坐标。截图坐标必须同时传 coordinate_scale。')
}

export function createComputerUseDoubleClickToolDefinition() {
  return pointDefinition(COMPUTER_USE_DOUBLE_CLICK_TOOL_NAME, '在指定显示器的坐标双击。截图坐标必须同时传 coordinate_scale。')
}

export function createComputerUseTypeToolDefinition() {
  return {
    name: COMPUTER_USE_TYPE_TOOL_NAME,
    description: '向当前系统焦点输入文本。密码、验证码、密钥和其他凭据必须由用户自行输入，不能要求或代填。',
    parameters: { type: 'object' as const, properties: { text: { type: 'string', description: '要输入的文本，最长 10000 个 UTF-16 字符' } }, required: ['text'] },
  }
}

export function createComputerUseScrollToolDefinition() {
  return {
    name: COMPUTER_USE_SCROLL_TOOL_NAME,
    description: '滚动当前前台窗口。系统级操作仍需用户授权。',
    parameters: { type: 'object' as const, properties: { direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number', description: '滚动像素，1 到 2000，默认 700' } }, required: ['direction'] },
  }
}

export function createComputerUseDragToolDefinition() {
  return {
    name: COMPUTER_USE_DRAG_TOOL_NAME,
    description: '在同一显示器内从起点拖拽至终点。截图坐标必须同时传 coordinate_scale；拖放文件、删除或提交前必须向用户说明后果并确认。',
    parameters: {
      type: 'object' as const,
      properties: { from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' }, ...DISPLAY_COORDINATE_PROPERTIES },
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
    },
  }
}

export function createComputerUseKeyComboToolDefinition() {
  return {
    name: COMPUTER_USE_KEY_COMBO_TOOL_NAME,
    description: '发送受限的 macOS 编辑或导航快捷键。密码、系统安全设置与锁屏组合不允许模拟。',
    parameters: {
      type: 'object' as const,
      properties: { key: { type: 'string', enum: ['a', 'c', 'v', 'x', 'z', 'f', 'tab', 'enter', 'escape', 'left', 'right', 'up', 'down'] }, modifiers: { type: 'array' } as unknown as { type: string } },
      required: ['key'],
    },
  }
}

export function createComputerUseRequestTakeoverToolDefinition() {
  return {
    name: COMPUTER_USE_REQUEST_TAKEOVER_TOOL_NAME,
    description: '请求用户接管密码、验证码、支付、发布、删除、授权、安全设置或最终提交。调用后 Agent 必须暂停，直到用户确认已完成或取消。',
    parameters: { type: 'object' as const, properties: { reason: { type: 'string' }, instruction: { type: 'string' } }, required: ['reason', 'instruction'] },
  }
}

async function executeComputerUseStatusUnchecked(_input: unknown, _ctx: ToolContext): Promise<ToolResult> { return result(await computerUseService.getStatus()) }
async function executeComputerUseCapabilitiesUnchecked(_input: unknown, _ctx: ToolContext): Promise<ToolResult> { return result(computerUseService.getCapabilities()) }
async function executeComputerUseFrontmostApplicationUnchecked(_input: unknown, _ctx: ToolContext): Promise<ToolResult> { return result(computerUseService.getFrontmostApplication()) }
async function executeComputerUseFrontmostWindowUnchecked(_input: unknown, _ctx: ToolContext): Promise<ToolResult> { return result(computerUseService.getFrontmostWindow()) }
async function executeComputerUseDisplaysUnchecked(_input: unknown, _ctx: ToolContext): Promise<ToolResult> { return result(computerUseService.getDisplays()) }
async function executeComputerUseRequestPermissionsUnchecked(_input: unknown, _ctx: ToolContext): Promise<ToolResult> { return result(await computerUseService.requestPermissions()) }

async function executeComputerUseScreenshotUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const fallbackError = requireComputerFallback(ctx)
  if (fallbackError) return fallbackError
  const screenshot = await computerUseService.screenshot(readString(input, 'display_id'))
  recordAudit(ctx, 'screenshot', { displayId: screenshot.displayId, width: screenshot.width, height: screenshot.height })
  return { toolCallId: '', content: JSON.stringify({ width: screenshot.width, height: screenshot.height, displayId: screenshot.displayId, scaleFactor: screenshot.scaleFactor, coordinateScale: screenshot.coordinateScale, message: '截图已附加。后续使用截图像素坐标时，必须将 coordinateScale 原样作为 coordinate_scale 传给操作工具。' }), imageData: [{ mediaType: screenshot.mediaType, data: screenshot.data }] }
}

async function executeComputerUseClickUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> { return executePoint(input, ctx, 'click') }
async function executeComputerUseMoveUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> { return executePoint(input, ctx, 'move') }
async function executeComputerUseDoubleClickUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> { return executePoint(input, ctx, 'doubleClick') }

async function executeComputerUseTypeUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const fallbackError = requireComputerFallback(ctx)
  if (fallbackError) return fallbackError
  const text = readString(input, 'text')
  if (!text) return error('text 必须是非空字符串')
  return runDesktopAction(
    'type', ctx, { length: text.length }, () => computerUseService.type(text), `text:${hashDetail(text)}`,
  )
}

async function executeComputerUseScrollUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const fallbackError = requireComputerFallback(ctx)
  if (fallbackError) return fallbackError
  const direction = readString(input, 'direction')
  const amount = readNumber(input, 'amount') ?? 700
  if ((direction !== 'up' && direction !== 'down') || !Number.isFinite(amount) || amount < 1 || amount > 2000) return error('direction 必须为 up 或 down，amount 必须为 1 到 2000 的数字')
  return runDesktopAction(
    'scroll', ctx, { direction, amount }, () => computerUseService.scroll(direction, amount), `${direction}:${amount}`,
  )
}

async function executeComputerUseDragUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const fallbackError = requireComputerFallback(ctx)
  if (fallbackError) return fallbackError
  const fromX = readNumber(input, 'from_x')
  const fromY = readNumber(input, 'from_y')
  const toX = readNumber(input, 'to_x')
  const toY = readNumber(input, 'to_y')
  if ([fromX, fromY, toX, toY].some((value) => value === undefined)) return error('拖拽坐标必须是数字')
  const scale = readCoordinateScale(input)
  if (scale === null) return error('coordinate_scale 必须为大于 0 且不大于 1 的数字')
  const displayId = readString(input, 'display_id')
  return runDesktopAction(
    'drag', ctx, { displayId, coordinateScale: scale },
    () => computerUseService.drag(fromX! / scale, fromY! / scale, toX! / scale, toY! / scale, displayId),
    `${fromX},${fromY}->${toX},${toY}@${displayId ?? 'primary'}`,
  )
}

async function executeComputerUseKeyComboUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const fallbackError = requireComputerFallback(ctx)
  if (fallbackError) return fallbackError
  const key = readString(input, 'key')
  const modifiers = isRecord(input) && Array.isArray(input.modifiers) && input.modifiers.every((value) => typeof value === 'string') ? input.modifiers as string[] : []
  if (!key) return error('key 必须是字符串')
  return runDesktopAction(
    'key_combo', ctx, { key, modifiers }, () => computerUseService.keyCombo(key, modifiers), `${key}+${modifiers.join('+')}`,
  )
}

async function executeComputerUseRequestTakeoverUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const reason = readString(input, 'reason')
  const instruction = readString(input, 'instruction')
  if (!reason || !instruction || !ctx.onAskUser || !ctx.abortSignal) return error('无法创建用户接管请求')
  const question = '完成敏感操作后继续吗？'
  const response = await ctx.onAskUser({
    interactionType: 'computer_use_takeover',
    questions: [{ question, header: '需要你接管', options: [{ label: '我已完成，可继续' }, { label: '取消' }] }],
  }, ctx.abortSignal)
  const answer = response.behavior === 'allow' ? response.answers[question] : undefined
  const completed = answer === '我已完成，可继续'
  recordAudit(ctx, 'takeover', { reason, completed })
  return completed ? result({ message: '用户已完成接管，可继续执行' }) : error('用户取消接管')
}

/**
 * 执行会改变机器状态的桌面动作。
 *
 * 成功 → 记 applied；抛错 → 按"未执行/结果未知"分类记账，未知时明确禁止自动重试。
 * 桌面动作没有 Provider 回执，这里不把"调用返回了"当成"确实生效"，也不把
 * "抛错"当成"没生效"。
 */
async function runDesktopAction(
  action: string,
  ctx: ToolContext,
  detail: Record<string, unknown>,
  run: () => Promise<string>,
  target?: string,
): Promise<ToolResult> {
  // 未知结果不能只写在提示里：同一次动作在结果确认前不允许再发一遍。
  const actionKey = buildActionKey(`computer-use:${action}`, target ?? hashDetail(detail))
  const blocked = await blockIfUnknownAction({
    sessionId: ctx.sessionId,
    tool: `ComputerUse${action}`,
    actionKey,
    confirmHint: '请先调用 ComputerUseScreenshot 确认屏幕状态，并由用户决定是否继续。',
  })
  if (blocked) return error(blocked)

  try {
    const message = await run()
    recordAudit(ctx, action, { ...detail, outcome: 'applied' })
    return result({ message, outcome: 'applied' })
  } catch (thrown) {
    const failure = describeDesktopActionFailure(action, thrown)
    recordAudit(ctx, action, { ...detail, outcome: failure.outcome, error: failure.reason })
    if (failure.outcome === 'unknown') {
      await recordUnknownAction({
        sessionId: ctx.sessionId,
        tool: `ComputerUse${action}`,
        actionKey,
        detail,
        reason: failure.reason,
      })
    }
    return error(failure.message)
  }
}

function definition(name: string, description: string) { return { name, description, parameters: { type: 'object' as const, properties: {} } } }
function pointDefinition(name: string, description: string) { return { name, description, parameters: { type: 'object' as const, properties: { x: { type: 'number' }, y: { type: 'number' }, ...DISPLAY_COORDINATE_PROPERTIES }, required: ['x', 'y'] } } }

async function executePoint(input: unknown, ctx: ToolContext, action: 'click' | 'move' | 'doubleClick'): Promise<ToolResult> {
  const fallbackError = requireComputerFallback(ctx)
  if (fallbackError) return fallbackError
  const x = readNumber(input, 'x')
  const y = readNumber(input, 'y')
  const scale = readCoordinateScale(input)
  if (x === undefined || y === undefined) return error('x 和 y 必须是数字')
  if (scale === null) return error('coordinate_scale 必须为大于 0 且不大于 1 的数字')
  const displayId = readString(input, 'display_id')
  return runDesktopAction(
    action, ctx, { displayId, coordinateScale: scale },
    () => computerUseService[action](x / scale, y / scale, displayId),
    `${x},${y}@${displayId ?? 'primary'}`,
  )
}

function readCoordinateScale(input: unknown): number | null {
  const scale = readNumber(input, 'coordinate_scale') ?? 1
  return Number.isFinite(scale) && scale > 0 && scale <= 1 ? scale : null
}

function recordAudit(ctx: ToolContext, action: string, detail: Record<string, unknown>): void {
  void appendComputerUseAudit(ctx.sessionId, action, detail).catch(() => undefined)
}

function requireComputerFallback(ctx: ToolContext): ToolResult | null {
  return webBridgeService.canUseComputerFallback(ctx.sessionId)
    ? null
    : error('当前 Web Bridge 提供结构化页面元素；请优先使用 WebBridge 工具。只有页面结构不可用时才能降级使用 Computer Use。')
}

function result(value: unknown): ToolResult { return { toolCallId: '', content: JSON.stringify(value, null, 2) } }
function error(content: string): ToolResult { return { toolCallId: '', content, isError: true } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function readString(value: unknown, key: string): string | undefined { return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined }
function readNumber(value: unknown, key: string): number | undefined { return isRecord(value) && typeof value[key] === 'number' ? value[key] : undefined }

export const executeComputerUseStatusTool = guardOwnerTool(COMPUTER_USE_STATUS_TOOL_NAME, executeComputerUseStatusUnchecked)

export const executeComputerUseCapabilitiesTool = guardOwnerTool(COMPUTER_USE_CAPABILITIES_TOOL_NAME, executeComputerUseCapabilitiesUnchecked)

export const executeComputerUseFrontmostApplicationTool = guardOwnerTool(COMPUTER_USE_FRONTMOST_APPLICATION_TOOL_NAME, executeComputerUseFrontmostApplicationUnchecked)

export const executeComputerUseFrontmostWindowTool = guardOwnerTool(COMPUTER_USE_FRONTMOST_WINDOW_TOOL_NAME, executeComputerUseFrontmostWindowUnchecked)

export const executeComputerUseDisplaysTool = guardOwnerTool(COMPUTER_USE_DISPLAYS_TOOL_NAME, executeComputerUseDisplaysUnchecked)

export const executeComputerUseRequestPermissionsTool = guardOwnerTool(COMPUTER_USE_REQUEST_PERMISSIONS_TOOL_NAME, executeComputerUseRequestPermissionsUnchecked)

export const executeComputerUseScreenshotTool = guardOwnerTool(COMPUTER_USE_SCREENSHOT_TOOL_NAME, executeComputerUseScreenshotUnchecked)

export const executeComputerUseClickTool = guardOwnerTool(COMPUTER_USE_CLICK_TOOL_NAME, executeComputerUseClickUnchecked)

export const executeComputerUseMoveTool = guardOwnerTool(COMPUTER_USE_MOVE_TOOL_NAME, executeComputerUseMoveUnchecked)

export const executeComputerUseDoubleClickTool = guardOwnerTool(COMPUTER_USE_DOUBLE_CLICK_TOOL_NAME, executeComputerUseDoubleClickUnchecked)

export const executeComputerUseTypeTool = guardOwnerTool(COMPUTER_USE_TYPE_TOOL_NAME, executeComputerUseTypeUnchecked)

export const executeComputerUseScrollTool = guardOwnerTool(COMPUTER_USE_SCROLL_TOOL_NAME, executeComputerUseScrollUnchecked)

export const executeComputerUseDragTool = guardOwnerTool(COMPUTER_USE_DRAG_TOOL_NAME, executeComputerUseDragUnchecked)

export const executeComputerUseKeyComboTool = guardOwnerTool(COMPUTER_USE_KEY_COMBO_TOOL_NAME, executeComputerUseKeyComboUnchecked)

export const executeComputerUseRequestTakeoverTool = guardOwnerTool(COMPUTER_USE_REQUEST_TAKEOVER_TOOL_NAME, executeComputerUseRequestTakeoverUnchecked)
