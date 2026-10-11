/**
 * 自定义斜杠命令 —— 纯函数模型
 *
 * 负责命令的校验、规范化与增删（返回新列表），持久化由调用方经 settings IPC 完成。
 */

import type { AgentCustomCommand } from '@/types/settings'

/** 命令名允许的字符：字母 / 数字 / 连字符 / 下划线（1-32 位） */
const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/

export type CustomCommandValidation =
  | { ok: true; command: AgentCustomCommand }
  | { ok: false; error: string }

/** 校验并规范化一条自定义命令；existing 用于重名检查（编辑场景可排除自身） */
export function validateCustomCommand(
  input: { name: string; prompt: string },
  existing: readonly AgentCustomCommand[],
  excludeName?: string,
): CustomCommandValidation {
  const name = input.name.trim()
  const prompt = input.prompt.trim()
  if (!NAME_RE.test(name)) {
    return { ok: false, error: '命令名需为 1-32 位字母、数字、连字符或下划线' }
  }
  if (!prompt) {
    return { ok: false, error: '提示词内容不能为空' }
  }
  if (existing.some((cmd) => cmd.name === name && cmd.name !== excludeName)) {
    return { ok: false, error: `命令 /${name} 已存在` }
  }
  return { ok: true, command: { name, prompt } }
}

/** 新增或替换（同名校验通过时视为新增；编辑用 replaceCustomCommand） */
export function addCustomCommand(
  list: readonly AgentCustomCommand[],
  command: AgentCustomCommand,
): AgentCustomCommand[] {
  return [...list, command]
}

/** 按命令名替换（编辑场景；不存在时追加） */
export function replaceCustomCommand(
  list: readonly AgentCustomCommand[],
  originalName: string,
  command: AgentCustomCommand,
): AgentCustomCommand[] {
  const idx = list.findIndex((cmd) => cmd.name === originalName)
  if (idx === -1) return [...list, command]
  const next = [...list]
  next[idx] = command
  return next
}

/** 按命令名删除 */
export function removeCustomCommand(
  list: readonly AgentCustomCommand[],
  name: string,
): AgentCustomCommand[] {
  return list.filter((cmd) => cmd.name !== name)
}
