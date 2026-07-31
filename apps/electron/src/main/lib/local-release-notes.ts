/**
 * 本地 release-notes 读取模块
 *
 * fork 仓库可能尚未在 GitHub 发布 Releases（如 andrewchay/proma-mit），
 * 因此版本历史优先从仓库内的 release-notes/*.md 读取，GitHub API 仅作补充。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { GitHubRelease } from '@proma/shared'
import { mergeReleases } from './release-notes-merge'

export { mergeReleases }

// 主进程经 esbuild 以 CJS 打包，__dirname 指向 dist/，import.meta.url 不可用

/** 解析 markdown 文件名为版本号：v0.9.41.md -> 0.9.41 */
function parseVersionFromFilename(filename: string): string | null {
  const match = /^v(\d+\.\d+(?:\.\d+)?)\.md$/i.exec(filename)
  return match?.[1] ?? null
}

/** 解析 markdown 首个 H1 标题（# Proma v0.9.41）为版本名称 */
function parseTitleFromBody(body: string): string {
  const match = /^#\s+(.+)$/m.exec(body.trim())
  return match?.[1]?.trim() ?? ''
}

/** 本地 release-notes 目录（打包后位于 process.resourcesPath/release-notes） */
function getReleaseNotesDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'release-notes')
  }
  // dev: dist/main.cjs 位于 apps/electron/dist/，release-notes 在仓库根目录
  return join(__dirname, '../../../release-notes')
}

/**
 * 读取本地 release-notes 目录，返回按版本号降序排列的 GitHubRelease 兼容结构。
 */
export function listLocalReleases(): GitHubRelease[] {
  try {
    const dir = getReleaseNotesDir()
    const filenames = readdirSync(dir).filter((name) => name.endsWith('.md'))
    const releases: GitHubRelease[] = []

    for (const filename of filenames) {
      const version = parseVersionFromFilename(filename)
      if (!version) continue
      const filePath = join(dir, filename)
      const body = readFileSync(filePath, 'utf-8')
      const publishedAt = statSync(filePath).mtime.toISOString()
      releases.push({
        // 稳定数字 id：版本号去掉小数点后转为整数；本地数据不依赖 GitHub API
        id: Number(version.replaceAll('.', '')),
        tag_name: `v${version}`,
        name: parseTitleFromBody(body) || `Proma v${version}`,
        body,
        draft: false,
        prerelease: false,
        created_at: publishedAt,
        published_at: publishedAt,
        html_url: `https://github.com/andrewchay/proma-mit/releases/tag/v${version}`,
      })
    }

    return mergeReleases(releases, [])
  } catch (error) {
    console.error('[本地版本历史] 读取 release-notes 失败:', error)
    return []
  }
}
