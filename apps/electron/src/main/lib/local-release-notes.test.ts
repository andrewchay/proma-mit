/** 本地 release-notes 读取模块测试。 */

import { describe, expect, test } from 'bun:test'
import { mergeReleases } from './release-notes-merge'
import type { GitHubRelease } from '@gravitas/shared'

function release(tag: string, body = ''): GitHubRelease {
  return {
    id: Number(tag.slice(1).replaceAll('.', '')),
    tag_name: tag,
    name: tag,
    body,
    draft: false,
    prerelease: false,
    created_at: '2026-01-01T00:00:00.000Z',
    published_at: '2026-01-01T00:00:00.000Z',
    html_url: `https://github.com/andrewchay/proma-mit/releases/tag/${tag}`,
  }
}

describe('mergeReleases', () => {
  test('本地为空时直接返回 GitHub 数据', () => {
    const github = [release('v0.9.12'), release('v0.9.11')]
    const merged = mergeReleases([], github)
    expect(merged.map((r) => r.tag_name)).toEqual(['v0.9.12', 'v0.9.11'])
  })

  test('GitHub 为空时返回本地数据', () => {
    const local = [release('v0.9.41'), release('v0.9.40')]
    const merged = mergeReleases(local, [])
    expect(merged.map((r) => r.tag_name)).toEqual(['v0.9.41', 'v0.9.40'])
  })

  test('本地与 GitHub 同时存在时本地优先去重并按版本降序', () => {
    const local = [
      release('v0.9.41', '本地正文'),
      release('v0.9.12', '本地正文'),
    ]
    const github = [
      release('v0.9.12', 'GitHub 正文'),
      release('v0.9.8'),
    ]
    const merged = mergeReleases(local, github)
    expect(merged.map((r) => r.tag_name)).toEqual(['v0.9.41', 'v0.9.12', 'v0.9.8'])
    const localV12 = merged.find((r) => r.tag_name === 'v0.9.12')
    expect(localV12?.body).toBe('本地正文')
  })

  test('版本号逐级比较：v0.10.0 应排在 v0.9.41 之前', () => {
    const merged = mergeReleases([release('v0.9.41')], [release('v0.10.0')])
    expect(merged.map((r) => r.tag_name)).toEqual(['v0.10.0', 'v0.9.41'])
  })
})
