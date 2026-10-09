# Agent Bash 沙箱（折中方案）实施证据

> 2026-10-09 14:40 GMT+8。决策来源：用户确认折中方案（`hooks/` 与 `config` 禁止写；缓存改为会话内目录）。

## 策略

| 类别 | 规则 |
|---|---|
| 可写 | 工作目录；会话私有 scratch（同时作为 `TMPDIR`、`BUN_INSTALL_CACHE_DIR`、`npm_config_cache`）；链接 worktree 的对象库、引用、日志与自身 gitdir；主工作区的 `.git` 整体（除下列禁止项） |
| 禁写 | `<common>/hooks/`；`<common>/config`（字面路径）；工作目录下的 `.git` 指针文件；主工作区中的 `worktrees/`（其他 worktree 的 gitdir） |
| 拒读写 | 应用配置目录（签名密钥与已签名记录） |
| 共享缓存 | 只读（沙箱不允许写入 `~/.bun/install/cache`、`~/.npm`） |
| 平台 | 仅 macOS。其他平台**默认拒绝执行**，返回明确错误 |

## 测试（真实 seatbelt 与真实 git 链接 worktree）

- 13 例通过：基础命令；scratch 可写、工作区外临时目录不可写；缓存环境指向 scratch；配置目录读写被拒；**链接 worktree 中 add/commit/log/branch 正常**；写 hooks 被拒；修改 config 与 `git config` 被拒；改写 `.git` 指针被拒；其他 worktree 的 gitdir 不可写；非 darwin 不执行；三组策略内容断言。
- 原有工具测试 20 例（`tool-impls`、`tool-effects`、`tool-resources`）全部通过。
- 测试过程中一次失败是测试 fixture 的目录名与配置目录重名（已改为 `repo-` 前缀）；三次失败是策略断言与 SBPL 多过滤器输出格式不一致（已改为子串断言，行为由真实沙箱测试覆盖）。

## 已知取舍与限制（需要你知道）

1. **`git config` 写入失败。** 本地配置（`git config --local`）会被拒绝。需要改配置时，请在沙箱外执行，或由用户修改。
2. **hooks 不能由 Agent 安装。** 需要 hook 的流程必须由用户设置。
3. **写 `/tmp` 等硬编码路径会失败。** 工具若忽略 `TMPDIR` 会失败；这是有意的收紧。
4. **包安装变慢。** 缓存在会话 scratch 中，不复用共享缓存；`bun install` 与 `npm install` 未做网络测试。
5. **Claude SDK 运行时的 Bash 不经过本模块**，无法包裹。使用该运行时的会话不受本沙箱约束。
6. 沙箱只约束进程的文件写入与配置读取；网络访问未限制。
7. `sandbox-exec` 为 Apple 标注的旧接口，长期可用性需评估。
8. 主工作区中 `.git` 下的其他根文件（如 `description`、`info/*`）仍可写；未逐项收紧。

## 版本与回滚

electron 0.12.125→0.12.126（shared 无类型变更）。回滚方式：恢复 `executeBashTool` 的 `exec` 调用，删除 `bash-sandbox.ts`。回滚会取消沙箱，因此需要单独授权。

## 用户决定（2026-10-09 14:33 GMT+8）

- Claude SDK 运行时后续会下线，其 Bash 不受沙箱约束的缺口不再处理（限制 5 不再作为待办）。
- `git config` 写入被拒绝的限制已接受（限制 1 视为既定取舍）。
