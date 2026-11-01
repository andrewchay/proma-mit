/** 项目级外网扫描的本机作品目录与文件路径；此处不依赖项目服务，供删除路径复用。 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getProjectsDir } from './config-paths'

export const WEB_WATCH_DIR_NAME = 'web-watch'
/** 扫描流水保留次数：超出即轮转，避免 JSONL 无界增长。 */
export const WEB_WATCH_RUN_RETENTION = 90

function assertSafeProjectId(projectId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error('项目 ID 无效')
}

export function getProjectWebWatchDir(): string {
  const path = join(getProjectsDir(), WEB_WATCH_DIR_NAME)
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
  return path
}

export function getProjectWebWatchConfigPath(projectId: string): string {
  assertSafeProjectId(projectId)
  return join(getProjectWebWatchDir(), `${projectId}.json`)
}

export function getProjectWebWatchRunsPath(projectId: string): string {
  assertSafeProjectId(projectId)
  return join(getProjectWebWatchDir(), `${projectId}.jsonl`)
}

/** 项目删除时清理本机扫描配置与流水；文件不存在不算失败。 */
export function removeProjectWebWatchFiles(projectId: string): void {
  assertSafeProjectId(projectId)
  for (const path of [getProjectWebWatchConfigPath(projectId), getProjectWebWatchRunsPath(projectId)]) {
    if (!existsSync(path)) continue
    try {
      rmSync(path, { force: true })
    } catch (error) {
      console.warn('[项目外网扫描] 清理扫描文件失败:', path, error instanceof Error ? error.message : error)
    }
  }
}
