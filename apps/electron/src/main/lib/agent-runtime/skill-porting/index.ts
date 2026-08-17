/**
 * Skill-Porting 编排：外部 skill → 审计 → 安装到 workspace。
 *
 * 流程：
 * 1. 解析来源 spec（GitHub repo / subdir / SKILL.md URL / skills.sh 名）
 * 2. pinned revision 抓取（默认 main，解析为 commit sha）
 * 3. 扫描定位 skill 目录 + 解析 frontmatter
 * 4. 逐文件审计（启发式安全审查）
 * 5. blocked → 拒绝；review → 需 force 或返回待确认；safe → 安装
 */

import { join } from 'node:path'
import { rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { SkillExternalSourceKind } from '@gravitas/shared'
import { fetchGitHub, fetchRawSkillMd, buildExternalSource } from './skill-fetcher'
import { locateSkill, parseSkillFrontmatter } from './skill-scanner'
import { auditSkill } from './skill-auditor'
import { installSkillToWorkspace } from './skill-installer'
import type { PortSkillResult, SkillPortingSpec } from './types'

export type { PortSkillResult, SkillPortingSpec } from './types'

/** 解析 GitHub spec：支持 `owner/repo` 或 `owner/repo@rev` 或 `owner/repo/subdir`。 */
function parseGitHubSpec(spec: string): { repo: string; rev?: string; subdir?: string } | null {
  const m = spec.match(/^([\w.-]+\/[\w.-]+)(?:@([\w.-]+))?(?:\/(.+))?$/)
  if (!m) return null
  return { repo: m[1]!, rev: m[2], subdir: m[3] }
}

/** 判断是 raw URL（https://…/SKILL.md）。 */
function isRawSkillMdUrl(spec: string): boolean {
  return /^https?:\/\/.+\.(md|markdown)$/i.test(spec)
}

/**
 * Port 一个外部 skill 到指定工作区。
 * @param force 为 true 时即使 review 也安装（人工确认放行）。
 */
export async function portSkill(
  workspaceSlug: string,
  input: SkillPortingSpec,
  opts: { force?: boolean } = {},
): Promise<PortSkillResult> {
  const spec = input.spec.trim()
  if (!spec) throw new Error('skill spec 不能为空')

  const workspaceDir = tmpdir()
  const workdir = join(workspaceDir, `gravitas-skill-port-${randomUUID()}`)
  rmSync(workdir, { recursive: true, force: true })

  try {
    // 1) 解析来源
    let skillRoot: string
    let pinnedRev: string
    let kind: SkillExternalSourceKind = 'github'

    if (isRawSkillMdUrl(spec)) {
      const rev = 'raw'
      const r = await fetchRawSkillMd(spec, workdir, rev)
      skillRoot = r.skillRoot
      pinnedRev = rev
      kind = 'raw'
    } else {
      const gh = parseGitHubSpec(spec)
      if (!gh) {
        // skills.sh 名兜底：走 GitHub 解析（常见 skills.sh 名就是 owner/repo 或能转成 repo）
        const asRepo = parseGitHubSpec(spec.replace(/^skills[:\/]/, ''))
        if (!asRepo) throw new Error(`无法解析 skill 来源 spec: ${spec}（支持 owner/repo、owner/repo@rev、owner/repo/subdir、SKILL.md URL）`)
        const r = await fetchGitHub(asRepo.repo, asRepo.rev ?? 'main', asRepo.subdir, workdir)
        skillRoot = r.skillRoot
        pinnedRev = r.actualRev
        kind = 'github'
      } else {
        const r = await fetchGitHub(gh.repo, gh.rev ?? 'main', gh.subdir, workdir)
        skillRoot = r.skillRoot
        pinnedRev = r.actualRev
      }
    }

    // 2) 定位 skill + frontmatter
    const located = locateSkill(skillRoot)
    const name = located.frontmatter.name || located.slug

    // 3) 审计
    const audit = auditSkill(skillRoot)

    // 4) blocked → 拒绝；review → 需 force；safe → 安装
    const installed = audit.verdict === 'safe' || (audit.verdict === 'review' && opts.force)
    if (!installed) {
      return {
        workspaceSlug,
        skillSlug: located.slug,
        audit,
        installed: false,
        pinnedRev,
        requestedSpec: spec,
      }
    }

    // 5) 安装
    const gh = parseGitHubSpec(spec)
    const externalSource = buildExternalSource(kind, spec, {
      repo: kind === 'github' ? gh?.repo : undefined,
      subdir: kind === 'github' ? gh?.subdir : undefined,
      rev: pinnedRev,
    })
    const result = installSkillToWorkspace({
      workspaceSlug,
      sourceSkillDir: skillRoot,
      name,
      externalSource,
      enabled: input.enabled,
    })

    return {
      workspaceSlug,
      skillSlug: result.skillSlug,
      audit,
      installed: true,
      installPath: result.path,
      pinnedRev,
      requestedSpec: spec,
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}
