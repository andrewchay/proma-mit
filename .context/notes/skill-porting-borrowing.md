# 调研：Skill-Porting（外部 skill 生态移植）落地

- 状态：**已落地**（2026-08-17，CLI/IPC 触发 + 启发式安全审查）
- 设计依据：`notes/penguin-hermes-borrowing.md`（penguin §5 skill-porting）

## 一、gravitas skill 系统现状（已核验）

### 内置 default-skills（38 个）
- 位置 `apps/electron/default-skills/<skill>/{SKILL.md, icon.svg, ...}`
- `SKILL.md` 用 frontmatter（name/description/version）+ markdown 正文
- `seedDefaultSkills()`（config-paths）→ 同步到 `~/.gravitas/default-skills/`（semver 比较升级）→ 再复制进 workspace `skills/`

### workspace skills（本地文件 CRUD）
`agent-workspace-manager.ts`：
- `getWorkspaceSkills` / `toggleWorkspaceSkill` / `deleteWorkspaceSkill` / `read/writeWorkspaceSkillContent` / `listSkillFiles`
- `parseSkillFrontmatter`：**已支持 block scalar（`|`/`>`）和多行缩进**，只认 name/description/icon/version（比 penguin 的单行 key:value 更宽容）
- **SkillImportSource**：已有"来源追踪"（sourceWorkspaceSlug + sourceVersion + importedAt），用于跨工作区导入/更新

### 外部生态接入现状 = 缺口
- **只有 `find-skills` 这个 skill**（135 行）：让 agent 用 `npx skills find/add` CLI 手动搜/装
- 无**工程化外部移植流程**：没有从 marketplace / Codex plugins / skills.sh / GitHub 抓取 → 结构化解压 → 逐文件安全审查 → frontmatter 归一 → **pinned revision** → 写入 workspace skills + source 追踪
- `importSkillFromWorkspace`/`updateSkillFromSource` 只处理**跨工作区**源，不是外部网络源

## 二、penguin skill-porting 设计（可借鉴精髓）
1. **多源解析**：Claude Code marketplace（`.claude-plugin/marketplace.json`）、Codex plugins、skills.sh 注册名、GitHub repo/子目录、本地目录 → 定位到 skill 目录
2. **扁平化 frontmatter**：转成单行 `key: value`（penguin 只认单行）；gravitas 已支持 block scalar，更省事
3. **逐文件完整审查**：尤其每个脚本；拒绝泄密/回连/混淆/篡改安全规则；不装没读过的
4. **pinned revision**：按 commit sha / tag 抓取（GitHub fetch 用 codeload tarball / raw / sparse checkout）
5. **记录来源**：装了什么、从哪、什么 revision → gravitas 已有 `SkillImportSource` 可扩展

## 三、与 gravitas 现状的 gap & 落点

| 能力 | gravitas | penguin | 落点 |
|---|---|---|---|
| 内置 skill + seed | ✅ | ✅ | 已有 |
| workspace skill CRUD | ✅ | ✅ | 已有 |
| frontmatter 解析 | ✅（更宽容） | ✅ | 已有 |
| 跨工作区导入 + source 追踪 | ✅ | — | 已有，可扩展 |
| **外部源解析**（marketplace/Codex/skills.sh/GitHub） | ❌ 无 | ✅ | **需新建** |
| **安全审查流程** | ❌ 无（find-skills 不审查） | ✅ | **需新建** |
| **pinned revision 抓取** | ❌ 无 | ✅ | **需新建** |
| **外部→workspace 写入 + source** | ❌ 无 | ✅ | **需新建** |

## 四、最小落地方向（待确认）

**新增一个 `agent-runtime/skill-porting/` 模块**：
1. `skill-source-resolver.ts`：解析来源（marketplace.json / skills.sh spec / GitHub owner+repo+子目录 / 本地路径）
2. `skill-fetcher.ts`：pinned revision 抓取（codeload tarball / raw GitHub API / npms skills）
3. `skill-scanner.ts`：从抓取内容里定位 skill 目录 + 校验 SKILL.md frontmatter（用现有 parseSkillFrontmatter）
4. `skill-auditor.ts`：**逐文件安全审查**（可疑脚本/回连/混淆/篡改规则的启发式标记）
5. `skill-installer.ts`：把审查通过的 skill 写入 workspace `skills/` + 写入扩展版 `SkillImportSource`（外部来源 + revision）+ 可选 frontmatter 归一

**触发面**：先作为「评测/agent 内部工具」或「IPC 命令」，agent 或用户在需要时调用；find-skills skill 可作为入口引导。

**边界**：审核结论默认只"标记风险、允许人工放行"；不自动装高风险脚本；pinned revision 保证可复现。

## 五、落地（已完成）

新增 `apps/electron/src/main/lib/agent-runtime/skill-porting/`：
- `skill-fetcher.ts`：GitHub codeload tarball + pinned rev→sha 解析、raw SKILL.md URL；走代理（getFetchFn+getEffectiveProxyUrl）
- `skill-scanner.ts`：递归 findSkillDirs（含 root）+ parseSkillFrontmatter
- `skill-auditor.ts`：启发式安全审查（remote-exec / exfil / phone-home / obfuscation / destructive / safety-bypass）→ safe/review/blocked
- `skill-installer.ts`：原子替换写入 workspace active/inactive + `.external-source.json`
- `index.ts` `portSkill(workspaceSlug, spec, {force})`：编排（blocked 拒 / review 需 force / safe 装）

IPC 触点：`AGENT_IPC_CHANNELS.PORT_SKILL`（ipc.ts + preload `portSkill`）。
shared：`SkillMeta.externalSource` + `SkillExternalSource`（repo/subdir/rev/originalSpec/kind）。

### 使用
- `window.electronAPI.portSkill(workspaceSlug, spec, { rev?, subdir?, enabled?, force? })`
- spec 支持 `owner/repo`、`owner/repo@rev`、`owner/repo/subdir`、`SKILL.md URL`

### 安全默认
- blocked（明显恶意）拒绝安装；review（可疑）需 force 人工确认；safe 自动装。
- pinned revision 固定（解析为 commit sha），source 记录在 `.external-source.json`。

### 质量
- 单测：auditor 7 / scanner 4 / installer 3 / port-skill 编排 3（mock fetcher），全绿；monorepo typecheck 通过；真 config 无泄漏。

### 待做/可选
- UI 嵌入（设置页 skill 导入入口）；skills.sh/npx skills 注册名到 GitHub 的更完整解析；把 `find-skills` skill 改造成走 portSkill。
