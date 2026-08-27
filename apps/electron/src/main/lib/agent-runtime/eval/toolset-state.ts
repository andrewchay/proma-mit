/**
 * 工具集状态快照/回滚（纯逻辑，不依赖 Electron/渠道，便于单测）。
 *
 * 被测对象 = `default-tools/<plugin-id>/` 里的工具集定义（marketing 等）。
 * 版本快照粒度 = TOOLS.md 内容；候选 afterState 可以是字符串（新 toolsMd）或
 * `{ toolsMd }` 对象。
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPluginToolsDirState } from '../../tool-definition-store'
import { getPluginToolsDir } from '../../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../../safe-file'
import type { StateGuard } from './self-evolver'
import type { SelfEvolveChange } from './types'

/** 读取工具集的当前（原始）TOOLS.md；未定义返回兜底描述。 */
export function readToolsetPrompt(pluginId: string): string {
  const state = readPluginToolsDirState(pluginId)
  return state?.toolsMd ?? `（${pluginId} 未定义 TOOLS.md）`
}

/**
 * 工具集的 StateGuard：版本化快照其 TOOLS.md，支持候选应用与回滚。
 * 不改动磁盘文件，只在内存里维护当前生效的 toolsMd 版本，
 * 评测时通过 `currentContent` 取用。
 */
export function buildToolsetStateGuard(pluginId: string): StateGuard & { currentContent: () => string | undefined } {
  const state = readPluginToolsDirState(pluginId)
  let currentToolsMd: string | undefined = state?.toolsMd
  let version = state?.version ?? 1
  const stack: Array<{ toolsMd: string | undefined; version: number }> = []

  return {
    currentContent: () => currentToolsMd,
    async snapshot() {
      stack.push({ toolsMd: currentToolsMd, version })
    },
    async apply(change: SelfEvolveChange) {
      const after = change.afterState as unknown
      if (typeof after === 'string') {
        currentToolsMd = after
      } else if (after && typeof after === 'object' && 'toolsMd' in (after as Record<string, unknown>)) {
        currentToolsMd = (after as Record<string, unknown>).toolsMd as string | undefined
      }
      version++
    },
    async restore() {
      const top = stack.pop()
      if (top) {
        currentToolsMd = top.toolsMd
        version = top.version
      }
    },
    version: () => version,
  }
}

/**
 * 采纳写回：把改进后的 TOOLS.md 写入工具集目录并 bump version。
 * 这是「工具即目录」下 trust 采纳的落地——目录即源，collectDirectoryToolPrompts 读取即生效。
 */
export function writeToolAgentsMd(pluginId: string, toolsMd: string): number {
  const dir = getPluginToolsDir(pluginId)
  writeFileSync(join(dir, 'TOOLS.md'), toolsMd.trim(), 'utf-8')

  // bump system_config.version
  const configPath = join(dir, 'system_config.json')
  const cfg = existsSync(configPath) ? readJsonFileSafe<{ version?: unknown }>(configPath) : null
  const version = (cfg && typeof cfg.version === 'number' ? cfg.version : 1) + 1
  writeJsonFileAtomic(configPath, {
    ...(cfg ?? {}),
    version,
    updatedAt: new Date().toISOString(),
  })
  return version
}
