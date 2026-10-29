# 新建仓库 config 可执行载体收口：局部证据

日期：2026-10-29；范围仅"本命令新建、且 gitdir 位于工作目录内"的仓库 config，不代表预存仓库、其他 Runtime 或 `GIT_DIR` 间接布局已覆盖。

## 缺口

上一轮已把新建仓库的 **hooks 目录**在命令后收口停用，但 config 本身同样是一条命令执行通道，且能在后续**普通** git 操作中被自动触发，无需用户显式调用：

| 键 | 触发时机 |
| --- | --- |
| `core.fsmonitor` | `git status` 等常规查询 |
| `core.pager` | 任何产生输出的 git 命令 |
| `filter.<name>.clean` / `smudge` / `process` | `git add` / `git checkout` |
| `diff.external` | `git diff` |
| `credential.helper` | 需要凭据的 fetch/push |
| `core.sshCommand`、`core.askpass`、`gpg.program`、`core.editor` | 对应操作 |
| `core.hooksPath` | 把 hook 目录指向其他位置，绕过 hooks 目录收口 |
| `include.path`、`includeIf.*.path` | 间接加载外部 config 中的以上任意键 |
| `alias.*`、`submodule.*.update`（值为 `!cmd`） | 用户/流程调用时 |

新建仓库的 config 由命令自身写出，seatbelt 无法在命令期间拒写（预 deny `.git/hooks` 已实测会让 `git init` 致命失败，见 `git-init-experiment-f.log`），因此只能在命令结束后清洗。

## 本次改动

- `isCommandCarryingConfigKey(fullKey, value)`：单一判定入口。固定键集合（上表除 alias/submodule 外）直接命中；`filter.*.{clean,smudge,process}`、`include(.if.*)?.path` 按模式命中；`alias.*`、`submodule.*.update` 仅在值以 `!` 开头时命中，避免误删普通别名。
- `sanitizeGitConfigText(text)`：纯函数，按行解析并跟踪 `[section]` / `[section "sub"]` / 老式 `[section.sub]`，因此小节形式与点分形式都能命中；`\` 续行整条移除，不留半条值；同名多值键全部移除；其余行与顺序原样保留。键名大小写不敏感。
- `sanitizeNewGitConfig(cwd, gitWasPresent)`：仅当命令前无 `.git`（新建仓库）且 config 位于工作目录内时执行。原 config 另存为 `config.gravitas-quarantine` 供审计与恢复，清洗结果原子写入（临时文件 + rename）。符号链接不跟随（改写链接目标等于越界写入）；写失败时保持原 config 不变并返回无改动。
- `quarantineNewGitArtifacts(cwd, gitWasPresent)`：合并入口，hooks + config 一起收口。Bash 工具的两个调用点（成功路径与失败路径）都改用它，避免只调用其中一半。

## 证据

`git-config-carrier.test.ts`（13 项）分三层：

1. **纯文本层**：九个载体键一次性移除且无关配置（`repositoryformatversion`、`filemode`、普通别名、`user.email`）保留；大小写与点分小节；续行整条移除；同名多值全删；无载体时原样返回；`isCommandCarryingConfigKey` 的六组正反例。
2. **文件系统层**：新建仓库改写并保留 `.gravitas-quarantine` 副本；命令前已存在的仓库完全不改动；无载体时不产生副本文件；config 为符号链接时不跟随；hooks 与 config 同时被注入时统一收口两者。
3. **真实 git 行为层**（git 2.54.0）：
   - `filter.evil.clean = touch marker; cat` + `.gitattributes`，`git add` **确实创建 marker**（先确认攻击有效，否则后面的"未执行"没有证明力）；清洗后重置 index 再 `git add`，marker 不再出现。
   - `core.fsmonitor` 指向脚本，`git status --porcelain` 触发执行（stderr 出现 `warning: Empty last update token.`，说明钩子被调用）；清洗后同一命令不再产生 marker，且 `git config --get core.fsmonitor` 取值失败。

宿主真机回归（`.context/cfg-carrier-verify.log`）：`git-config-carrier` 13 项、`bash-sandbox` 37 项、`tool-impls` 20 项，**三套件零失败**。受限会话内 `bash-sandbox` 的那批失败是嵌套 `sandbox_apply` 返回 EPERM 的环境限制，与本改动无关，故改用宿主 Terminal 复验。

## 边界

- **只覆盖本命令新建且 gitdir 在工作目录内的仓库**。预存仓库的 config 由 seatbelt 策略拒写（`finalDenyWriteLiterals` 含 `join(commonDir, 'config')`），不在本切片范围。
- **`GIT_DIR` / `GIT_CONFIG_GLOBAL` 等环境变量间接布局未覆盖**：命令可以用环境变量或 `-c` 参数把 config 指到工作目录外，或在命令运行期间使用注入的 config。命令**运行期间**的执行本就无法用"命令后收口"拦截——本切片只关闭持久化到后续操作的通道。
- **清洗是黑名单**：git 新增执行型 config 键时需要同步维护 `COMMAND_CARRYING_CONFIG_KEYS`；白名单式"只保留 git init 默认键"更严但会误删 `git init && git remote add` 这类同命令合法配置，故未采用。
- **`include.path` 被移除而非展开检查**：被 include 的外部文件本身不会被改动（它可能属于其他会话）；移除指令即切断加载路径。
- 用户若手动删除 `config.gravitas-quarantine` 副本，审计线索随之消失；清洗结果只保证不再执行，不保证还原原始文件内容。
- 未做真实 Electron 打包应用验证；测试为 Bun 运行时下的真实文件系统与真实 git 二进制调用。
