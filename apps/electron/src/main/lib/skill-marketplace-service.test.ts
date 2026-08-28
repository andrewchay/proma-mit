
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createAgentWorkspace, getAllWorkspaceSkills, toggleSkillSet, toggleWorkspaceSkill } from "./agent-workspace-manager"
import { getInactiveSkillsDir, getWorkspaceSkillsDir } from "./config-paths"
import { getSkillMarketplace, installMarketplaceSkill } from "./skill-marketplace-service"

const TEST_DIR = "/tmp/proma-skill-marketplace-test"

function writeSkill(dir: string, slug: string, version: string, category: string): void {
  const skillDir = join(dir, slug)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: " + slug + "\ndescription: " + slug + " 描述\nversion: " + version + "\ncategory: " + category + "\n---\n内容\n", "utf-8")
}

describe("Skills 集市与 Skill Set", () => {
  beforeAll(() => { process.env.PROMA_TEST_CONFIG_DIR = TEST_DIR })
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterAll(() => { rmSync(TEST_DIR, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

  test("Given 前缀 Skill Set When 批量停用再启用 Then 仅移动对应 Skills", () => {
    const workspace = createAgentWorkspace("批量切换")
    writeSkill(getWorkspaceSkillsDir(workspace.slug), "marketing-brand", "1.0.0", "营销")
    writeSkill(getWorkspaceSkillsDir(workspace.slug), "research-note", "1.0.0", "研究")
    writeSkill(getInactiveSkillsDir(workspace.slug), "marketing-copy", "1.0.0", "营销")
    expect(toggleSkillSet(workspace.slug, "marketing", false)).toEqual(["marketing-brand"])
    expect(existsSync(join(getInactiveSkillsDir(workspace.slug), "marketing-brand"))).toBe(true)
    expect(existsSync(join(getWorkspaceSkillsDir(workspace.slug), "research-note"))).toBe(true)
    expect(toggleSkillSet(workspace.slug, "marketing", true).sort()).toEqual(["marketing-brand", "marketing-copy"])
    expect(getAllWorkspaceSkills(workspace.slug).filter((skill) => skill.slug.startsWith("marketing-")).every((skill) => skill.enabled)).toBe(true)
  })

  test("Given 集市来源 When 安装和更新 Then 分类可发现且保留停用状态", () => {
    const target = createAgentWorkspace("目标工作区")
    const source = createAgentWorkspace("来源工作区")
    writeSkill(getWorkspaceSkillsDir(source.slug), "marketing-brand", "1.0.0", "营销")
    const available = getSkillMarketplace(target.slug).find((item) => item.sourceWorkspaceSlug === source.slug && item.slug === "marketing-brand")
    expect(available?.category).toBe("营销")
    expect(available?.installStatus).toBe("available")
    installMarketplaceSkill(target.slug, { source: "workspace", sourceWorkspaceSlug: source.slug }, "marketing-brand")
    expect(getAllWorkspaceSkills(target.slug).find((skill) => skill.slug === "marketing-brand")?.enabled).toBe(true)
    toggleWorkspaceSkill(target.slug, "marketing-brand", false)
    writeSkill(getWorkspaceSkillsDir(source.slug), "marketing-brand", "1.1.0", "营销")
    const update = getSkillMarketplace(target.slug).find((item) => item.sourceWorkspaceSlug === source.slug && item.slug === "marketing-brand")
    expect(update?.installStatus).toBe("update_available")
    installMarketplaceSkill(target.slug, { source: "workspace", sourceWorkspaceSlug: source.slug }, "marketing-brand")
    const installed = getAllWorkspaceSkills(target.slug).find((skill) => skill.slug === "marketing-brand")
    expect(installed?.enabled).toBe(false)
    expect(installed?.version).toBe("1.1.0")
  })
})
