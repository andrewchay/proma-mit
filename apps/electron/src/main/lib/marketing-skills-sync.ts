/**
 * 营销 Skills 工作区分发器（surface: 'agent-skills' 的落地执行层）。
 *
 * 职责：把营销 plugin（com.gravitas.marketing）contributeSkills 声明的 skill
 * （来源：bundle → seedMarketingSkills 同步后的 ~/.proma-mit/marketing-skills/）
 * 增量同步到各工作区的 .marketing-plugin/ 目录，并生成 .claude-plugin/plugin.json，
 * 供 SDK 以第二个 local plugin（--plugin-dir）发现注入。
 *
 * 设计要点：
 * - 订阅驱动：collectContributingSkills() 返回空（未订阅任何营销域）时整体清理，
 *   保证「新建项目不默认带入」「取消订阅即消失」。
 * - 增量同步：新增缺失 / 版本比对覆盖（rm-then-cp）/ 删除不再贡献的 skill。
 * - 声明式安全边界：文件系统写入集中在主进程本模块，插件只声明 slug 与来源。
 * - 生效时机：下次会话装配（agent-orchestrator 读 .marketing-plugin），不打断进行中会话。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { compareSemver, getAgentWorkspacePath, parseSkillVersion } from './config-paths'
import { listAgentWorkspaces } from './agent-workspace-manager'
import { safeReplaceSkillDir, skillCopyFilter } from './agent-workspace-manager'
import { collectContributingSkills } from './plugin-manager'

/** 工作区营销 plugin 目录（第二个 local plugin 传给 SDK） */
export function getMarketingPluginDir(workspaceSlug: string): string {
  return join(getAgentWorkspacePath(workspaceSlug), '.marketing-plugin')
}

/**
 * 把营销 plugin 贡献的 skills 增量同步到指定工作区。
 *
 * - 未订阅（贡献为空）：整体清理 .marketing-plugin/
 * - 已订阅：增/删/升三个动作 + 写 .claude-plugin/plugin.json
 */
export function syncMarketingSkillsForWorkspace(workspaceSlug: string): void {
  let skills: ReturnType<typeof collectContributingSkills>
  try {
    skills = collectContributingSkills()
  } catch (err) {
    console.warn('[营销 Skills] 收集插件 skill 贡献失败，跳过同步:', err)
    return
  }

  const pluginDir = getMarketingPluginDir(workspaceSlug)
  const skillsDir = join(pluginDir, 'skills')

  // 未订阅任何营销域：整体清理（幂等）
  if (skills.length === 0) {
    if (existsSync(pluginDir)) {
      try {
        rmSync(pluginDir, { recursive: true, force: true })
        console.log(`[营销 Skills] 已清理工作区营销 plugin 目录: ${workspaceSlug}`)
      } catch (err) {
        console.warn(`[营销 Skills] 清理失败 (${workspaceSlug}):`, err)
      }
    }
    return
  }

  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true })
  }

  // 1) 删除不再贡献的 skill（退订/映射变更）
  const wanted = new Set(skills.map((s) => s.slug))
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || wanted.has(entry.name)) continue
      try {
        rmSync(join(skillsDir, entry.name), { recursive: true, force: true })
        console.log(`[营销 Skills] 已移除: ${workspaceSlug}/${entry.name}`)
      } catch (err) {
        console.warn(`[营销 Skills] 移除失败 (${workspaceSlug}/${entry.name}):`, err)
      }
    }
  } catch (err) {
    console.warn(`[营销 Skills] 扫描已有 skills 失败 (${workspaceSlug}):`, err)
  }

  // 2) 新增缺失 / 版本比对覆盖
  for (const skill of skills) {
    const target = join(skillsDir, skill.slug)
    try {
      if (!existsSync(target)) {
        cpSync(skill.sourcePath, target, { recursive: true, filter: skillCopyFilter })
        console.log(`[营销 Skills] 已分发: ${workspaceSlug}/${skill.slug}`)
        continue
      }
      const current = parseSkillVersion(target)
      const incoming = skill.version ?? parseSkillVersion(skill.sourcePath)
      if (compareSemver(incoming, current) > 0) {
        if (safeReplaceSkillDir(skill.sourcePath, target)) {
          console.log(`[营销 Skills] 已升级: ${workspaceSlug}/${skill.slug} (${current} → ${incoming})`)
        } else {
          console.warn(`[营销 Skills] 升级失败 (${workspaceSlug}/${skill.slug})，跳过`)
        }
      }
    } catch (err) {
      console.warn(`[营销 Skills] 同步失败 (${workspaceSlug}/${skill.slug}):`, err)
    }
  }

  // 3) 写 plugin manifest（SDK 经 .claude-plugin/plugin.json 发现 skills）
  try {
    const manifestDir = join(pluginDir, '.claude-plugin')
    if (!existsSync(manifestDir)) mkdirSync(manifestDir, { recursive: true })
    writeFileSync(
      join(manifestDir, 'plugin.json'),
      JSON.stringify({ name: `proma-marketing-${workspaceSlug}`, version: '1.0.0' }, null, 2),
      'utf-8',
    )
  } catch (err) {
    console.warn(`[营销 Skills] 写入 plugin manifest 失败 (${workspaceSlug}):`, err)
  }
}

/** 对所有工作区执行营销 skills 同步（启动期 / 订阅变更后调用） */
export function syncMarketingSkillsForAllWorkspaces(): void {
  try {
    for (const ws of listAgentWorkspaces()) {
      syncMarketingSkillsForWorkspace(ws.slug)
    }
  } catch (err) {
    console.warn('[营销 Skills] 全工作区同步失败:', err)
  }
}
