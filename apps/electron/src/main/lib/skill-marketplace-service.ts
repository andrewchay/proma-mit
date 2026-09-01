
/** Skills 集市：汇总内置模板与其他工作区，并以原子目录替换方式安装。 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { getDefaultSkillsDir, getInactiveSkillsDir, getWorkspaceSkillsDir } from "./config-paths"
import { getAllWorkspaceSkills, listAgentWorkspaces } from "./agent-workspace-manager"
import type { SkillMarketplaceItem, SkillMeta } from "@gravitas/shared"

export interface MarketplaceSkillSource {
  source: "builtin" | "workspace" | "personal" | "claude"
  sourceWorkspaceSlug?: string
  sourceRelativePath?: string
}

function readSkillMeta(dir: string, slug: string, enabled: boolean): SkillMeta | null {
  const path = join(dir, "SKILL.md")
  if (!existsSync(path)) return null
  const values: Record<string, string> = {}
  const frontmatter = readFileSync(path, "utf-8").match(/^---\s*\n([\s\S]*?)\n---/)
  if (frontmatter?.[1]) {
    for (const line of frontmatter[1].split("\n")) {
      const match = line.match(/^(name|description|icon|version|category):\s*(.+)\s*$/)
      if (match?.[1] && match[2]) values[match[1]] = match[2].trim().replace(/^["\x27]|["\x27]$/g, "")
    }
  }
  return { slug, name: values.name || slug, description: values.description, icon: values.icon, version: values.version, category: values.category, enabled }
}

function findSkillDir(workspaceSlug: string, skillSlug: string): string | null {
  for (const dir of [getWorkspaceSkillsDir(workspaceSlug), getInactiveSkillsDir(workspaceSlug)]) {
    const candidate = join(dir, skillSlug)
    if (existsSync(join(candidate, "SKILL.md"))) return candidate
  }
  return null
}

function scanDirectory(dir: string, source: MarketplaceSkillSource, sourceName?: string): SkillMarketplaceItem[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory()) return []
      const meta = readSkillMeta(join(dir, entry.name), entry.name, true)
      return meta ? [{ ...meta, id: `${source.source}:${source.sourceWorkspaceSlug ?? "default"}:${entry.name}`, source: source.source, sourceWorkspaceSlug: source.sourceWorkspaceSlug, sourceWorkspaceName: sourceName, installStatus: "available" as const }] : []
    })
  } catch {
    return []
  }
}

const EXTERNAL_SKILL_SOURCES = [
  { source: "claude" as const, name: "Claude Skills", root: "/Users/chaihao/.claude/skills" },
  { source: "personal" as const, name: "个人 Skills", root: "/Users/chaihao/.proma/agent-workspaces/personal/skills" },
]

function scanExternalDirectory(root: string, source: "personal" | "claude", sourceName: string): SkillMarketplaceItem[] {
  const items: SkillMarketplaceItem[] = []
  const visit = (dir: string, relativeDir: string): void => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      const relativePath = relativeDir ? relativeDir + "/" + entry.name : entry.name
      const path = join(dir, entry.name)
      const meta = readSkillMeta(path, relativePath.replaceAll("/", "--"), true)
      if (meta) items.push({ ...meta, id: source + ":" + relativePath, source, sourceWorkspaceName: sourceName, sourceRelativePath: relativePath, installStatus: "available" })
      visit(path, relativePath)
    }
  }
  visit(root, "")
  return items
}

function resolveExternalSkillPath(source: "personal" | "claude", relativePath?: string): string | null {
  if (!relativePath || relativePath.split("/").some((part) => !part || part === "." || part === "..")) return null
  const root = EXTERNAL_SKILL_SOURCES.find((candidate) => candidate.source === source)?.root
  return root ? join(root, relativePath) : null
}

/**
 * 集市按能力展示，而不是按目录镜像展示。来源优先级由调用方传入顺序决定。
 * growth-copilot 只负责在 growth-scout 前澄清问题，两者同时存在时保留可直接完成分析的后者。
 */
const REDUNDANT_SKILL_NAMES = new Map([["growth-copilot", "growth-scout"]])

function normalizeSkillName(item: SkillMeta): string {
  return item.name.normalize("NFKC").trim().replaceAll(/\s+/g, " ").toLocaleLowerCase()
}

export function deduplicateMarketplaceSkills(items: SkillMarketplaceItem[]): SkillMarketplaceItem[] {
  const availableNames = new Set(items.map(normalizeSkillName))
  const seenNames = new Set<string>()
  return items.filter((item) => {
    const name = normalizeSkillName(item)
    const replacement = REDUNDANT_SKILL_NAMES.get(name)
    if (replacement && availableNames.has(replacement)) return false
    if (seenNames.has(name)) return false
    seenNames.add(name)
    return true
  })
}

export function getSkillMarketplace(workspaceSlug: string): SkillMarketplaceItem[] {
  const installed = new Map(getAllWorkspaceSkills(workspaceSlug).map((skill) => [skill.slug, skill]))
  const items = scanDirectory(getDefaultSkillsDir(), { source: "builtin" }, "内置 Skills")
  for (const external of EXTERNAL_SKILL_SOURCES) {
    for (const item of scanExternalDirectory(external.root, external.source, external.name)) {
      items.push(item)
    }
  }
  for (const workspace of listAgentWorkspaces()) {
    if (workspace.slug === workspaceSlug) continue
    for (const skill of getAllWorkspaceSkills(workspace.slug)) {
      const dir = findSkillDir(workspace.slug, skill.slug)
      const meta = dir ? readSkillMeta(dir, skill.slug, skill.enabled) : null
      if (meta) items.push({ ...meta, id: `workspace:${workspace.slug}:${skill.slug}`, source: "workspace", sourceWorkspaceSlug: workspace.slug, sourceWorkspaceName: workspace.name, installStatus: "available" })
    }
  }
  return deduplicateMarketplaceSkills(items).map((item) => {
    const categorized = { ...item, ...classifySkillSet(item) }
    const current = installed.get(item.slug)
    return current ? { ...categorized, installStatus: isNewer(item.version, current.version) ? "update_available" as const : "installed" as const } : categorized
  }).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
}

export function installMarketplaceSkill(workspaceSlug: string, source: MarketplaceSkillSource, skillSlug: string): SkillMeta {
  const sourceDir = source.source === "builtin"
    ? join(getDefaultSkillsDir(), skillSlug)
    : source.source === "personal" || source.source === "claude"
      ? resolveExternalSkillPath(source.source, source.sourceRelativePath)
      : source.sourceWorkspaceSlug ? findSkillDir(source.sourceWorkspaceSlug, skillSlug) : null
  if (!sourceDir || !existsSync(join(sourceDir, "SKILL.md"))) throw new Error(`集市来源中不存在 Skill: ${skillSlug}`)
  const activeDir = getWorkspaceSkillsDir(workspaceSlug)
  const inactiveDir = getInactiveSkillsDir(workspaceSlug)
  const inactivePath = join(inactiveDir, skillSlug)
  const enabled = !existsSync(inactivePath)
  const targetDir = enabled ? activeDir : inactiveDir
  const targetPath = join(targetDir, skillSlug)
  mkdirSync(targetDir, { recursive: true })
  const staging = join(targetDir, `.${skillSlug}.marketplace-installing`)
  rmSync(staging, { recursive: true, force: true })
  try {
    cpSync(sourceDir, staging, { recursive: true })
    rmSync(targetPath, { recursive: true, force: true })
    renameSync(staging, targetPath)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  const meta = readSkillMeta(targetPath, skillSlug, enabled)
  if (!meta) throw new Error(`安装后的 Skill 缺少 SKILL.md: ${skillSlug}`)
  return meta
}

const SKILL_SET_RULES: Array<{ name: string; subset: string; terms: string[] }> = [
  { name: "开发工程", subset: "编码与架构", terms: ["code", "typescript", "javascript", "python", "api", "architecture"] },
  { name: "开发工程", subset: "测试与调试", terms: ["debug", "test", "qa", "error"] },
  { name: "开发工程", subset: "交付与安全", terms: ["git", "ci", "deploy", "performance", "security"] },
  { name: "研究与写作", subset: "文献与证据", terms: ["research", "paper", "citation", "academic", "literature"] },
  { name: "研究与写作", subset: "写作与审阅", terms: ["writing", "review", "essay"] },
  { name: "数据与分析", subset: "数据查询与处理", terms: ["data", "sql", "cohort"] },
  { name: "数据与分析", subset: "统计与实验", terms: ["analysis", "statistical", "experiment", "forecast"] },
  { name: "数据与分析", subset: "可视化", terms: ["visualization", "chart", "plot"] },
  { name: "生命科学", subset: "生物医学数据", terms: ["bio", "gen", "clinical", "drug", "protein", "genome", "chem", "medical"] },
  { name: "营销与增长", subset: "品牌与增长", terms: ["marketing", "brand", "campaign", "growth", "seo", "content", "social", "sales"] },
  { name: "产品与设计", subset: "产品策略与体验", terms: ["product", "prd", "design", "ui", "ux", "prototype", "roadmap", "user research"] },
  { name: "智能体与自动化", subset: "Agent 与编排", terms: ["agent", "skill", "workflow", "automation", "orchestrat", "prompt", "mcp"] },
  { name: "文档与媒体", subset: "内容制作", terms: ["document", "pdf", "ppt", "slide", "video", "image", "audio", "transcri"] },
  { name: "商业与决策", subset: "财务与经营", terms: ["finance", "stock", "investment", "legal", "strategy", "business", "stakeholder"] },
]

function classifySkillSet(item: SkillMeta): Pick<SkillMeta, "skillSet" | "skillSubSet"> {
  const haystack = [item.slug, item.name, item.description, item.category].filter(Boolean).join(" ").toLowerCase()
  const matched = SKILL_SET_RULES.find((rule) => rule.terms.some((term) => haystack.includes(term)))
  return matched ? { skillSet: matched.name, skillSubSet: matched.subset } : { skillSet: "通用效率", skillSubSet: "通用工具" }
}

function isNewer(source?: string, target?: string): boolean {
  const parse = (value?: string): number[] => (value ?? "0.0.0").split(".").map((part) => Number(part) || 0)
  const left = parse(source)
  const right = parse(target)
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0)
  }
  return false
}
