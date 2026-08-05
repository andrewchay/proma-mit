/** release-notes 合并逻辑（纯函数，无 Electron 依赖，便于单测）。 */

import type { GitHubRelease } from '@gravitas/shared'

function versionParts(tag: string): number[] {
  return tag.replace(/^v/i, '').split('.').map(Number)
}

/** 按版本号降序比较（新版本在前）。 */
function compareByVersion(a: string, b: string): number {
  const pa = versionParts(a)
  const pb = versionParts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 合并本地与 GitHub Releases，按版本号降序去重（本地优先）。
 */
export function mergeReleases(local: GitHubRelease[], github: GitHubRelease[]): GitHubRelease[] {
  const seen = new Set<string>()
  const merged: GitHubRelease[] = []
  for (const release of [...local, ...github]) {
    const tag = release.tag_name
    if (seen.has(tag)) continue
    seen.add(tag)
    merged.push(release)
  }
  merged.sort((a, b) => compareByVersion(a.tag_name, b.tag_name))
  return merged
}
