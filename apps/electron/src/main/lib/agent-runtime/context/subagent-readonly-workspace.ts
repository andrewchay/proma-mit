import { mkdirSync } from 'node:fs'

/**
 * 为显式启用 TCC 只读边界的子任务选择工作目录。
 *
 * 子任务不得复用调用方传入的 cwd 或评测沙箱；它只能在自己的私有会话目录
 * 中读取投影并返回结果。实际工具权限由 spawn 层同时收紧为 safe，避免通过
 * Bash 或写工具越过这个目录边界。
 */
export function resolveSubAgentWorkspace(input: {
  readOnly: boolean
  parentWorkspaceDir: string
  childWorkspaceDir: string
  explicitWorkspaceDir?: string
}): string {
  if (!input.readOnly) {
    return input.explicitWorkspaceDir ?? input.parentWorkspaceDir
  }

  mkdirSync(input.childWorkspaceDir, { recursive: true })
  return input.childWorkspaceDir
}
