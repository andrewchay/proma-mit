/**
 * Skill 外部拉取器（pinned revision）。
 *
 * 支持来源：
 * - GitHub repo / 子目录：codeload tarball（按 rev 固定），再用 git-tree API 或 tar 析取目录
 * - raw SKILL.md URL
 * - skills.sh / npx skills registry 名（解析到 GitHub 后走 GitHub 路径）
 *
 * 原则：总是**固定 revision**（commit sha 或 tag），保证安装可复现、可审计来源。
 * 网络统一走 app 代理（getFetchFn + getEffectiveProxyUrl）。
 */

import { join } from 'node:path'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { getFetchFn } from '../../proxy-fetch'
import { getEffectiveProxyUrl } from '../../proxy-settings-service'
import type { SkillExternalSource, SkillExternalSourceKind } from '@gravitas/shared'

export interface FetchResult {
  /** 解压后的 skill 根目录（含 SKILL.md） */
  skillRoot: string
  /** 实际固定的 rev（提交 sha，供追溯） */
  actualRev: string
  /** 归一化 externalSource */
  source: SkillExternalSource
}

/** 简单 tarball 解压（gzip + tar，内存操作，规避依赖）。 */
async function extractTarball(tarball: ArrayBuffer, targetDir: string): Promise<void> {
  // 使用系统 tar 处理（gravitas 运行时已有 tar，避免引依赖）
  const { execFileSync } = await import('node:child_process')
  mkdirSync(targetDir, { recursive: true })
  const tmp = join(targetDir, '.tarball.tar.gz')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(tmp, new Uint8Array(tarball))
  execFileSync('tar', ['-xzf', tmp, '-C', targetDir, '--strip-components=1'], { stdio: 'inherit' })
  rmSync(tmp, { force: true })
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const proxyUrl = await getEffectiveProxyUrl()
  const fetch = getFetchFn(proxyUrl)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`拉取失败 ${res.status}: ${url}`)
  return res.arrayBuffer()
}

/** 从 GitHub 抓取某 pinned rev 的仓库 tarball。 */
export async function fetchGitHub(
  repo: string,
  rev: string,
  subdir: string | undefined,
  targetDir: string,
): Promise<{ actualRev: string; skillRoot: string }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`非法 GitHub repo: ${repo}`)
  const [owner, name] = repo.split('/')
  const tarballUrl = `https://codeload.github.com/${owner}/${name}/tar.gz/${rev}`
  const buf = await fetchBuffer(tarballUrl)
  const extractDir = join(targetDir, '_extract')
  rmSync(extractDir, { recursive: true, force: true })
  await extractTarball(buf, extractDir)

  // 确定 skill 根目录：subdir 或整仓扫描出的 SKILL.md
  let skillRoot: string
  const scan = await import('./skill-scanner')
  if (subdir) {
    skillRoot = join(extractDir, subdir)
    if (!existsSync(join(skillRoot, 'SKILL.md'))) {
      throw new Error(`GitHub ${repo}@${rev} 子目录 ${subdir} 没有 SKILL.md`)
    }
  } else {
    // 扫描出含 SKILL.md 的目录（兼容 repo 根 / skills/<name> / 一层嵌套）
    const dirs = await scan.findSkillDirs(extractDir)
    if (dirs.length === 0) throw new Error(`GitHub ${repo}@${rev} 未找到 SKILL.md`)
    skillRoot = dirs[0]!
  }

  // 解析实际固定 rev（取 tarball 里记录的 commit 不可行，用 API 解析 ref→sha）
  const actualRev = rev.length >= 7 && rev.length <= 40 ? rev : await resolveRefToSha(repo, rev)
  return { actualRev, skillRoot }
}

/** 解析 GitHub ref/tag → commit sha。 */
export async function resolveRefToSha(repo: string, ref: string): Promise<string> {
  const proxyUrl = await getEffectiveProxyUrl()
  const fetch = getFetchFn(proxyUrl)
  const url = `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub 解析 ref 失败 ${res.status}: ${repo}@${ref}`)
  const data = (await res.json()) as { sha: string }
  return data.sha
}

/** 从 raw SKILL.md URL 拉取成一个单文件 skill 目录。 */
export async function fetchRawSkillMd(url: string, targetDir: string, rev: string): Promise<{ skillRoot: string }> {
  const buf = await fetchBuffer(url)
  const text = new TextDecoder().decode(buf)
  const skillRoot = join(targetDir, 'skill')
  mkdirSync(skillRoot, { recursive: true })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(skillRoot, 'SKILL.md'), text, 'utf-8')
  return { skillRoot }
}

/** 把来源归一成 externalSource（供 installer 记录）。 */
export function buildExternalSource(
  kind: SkillExternalSourceKind,
  spec: string,
  params: { repo?: string; subdir?: string; rev: string },
): SkillExternalSource {
  return {
    kind,
    repo: params.repo,
    subdir: params.subdir,
    rev: params.rev,
    originalSpec: spec,
    importedAt: new Date().toISOString(),
  }
}
