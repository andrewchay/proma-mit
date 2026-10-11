# V03 固定基线验证器证据

> 2026-10-09 11:10 GMT+8。用户决策：采用“固定到已提交基线，在干净 checkout 中验证”。

## 实现

- `apps/electron/src/main/lib/pinned-baseline-verifier.ts`：只通过 `git archive <完整40位SHA>` 导出 commit 内容到临时目录，再解包执行；工作树未提交改动与 ignored 文件均不进入副本。
- 受保护命令以 argv 数组 spawn（不经 shell），`{{JUNIT_REPORT}}` 占位符由主进程替换为副本外的临时报告路径。
- 判定只看 JUnit 根节点计数：退出码不在允许集合、超时、采集缺失、测试数不足、存在失败/错误，均不通过；无法启动为 unknown。
- 结束后删除临时副本与报告目录（回执 `cleanedUp: true`）。

## 验证（9 例，真实 git 与 bun 进程）

- 工作树未提交的失败修改不影响已提交的通过基线（verdict passed）。
- 已提交的失败测试判定 failed。
- 零测试、退出码 0 也不通过（collection_missing 或 too_few_tests）。
- 超时判 failed 并回收子进程。
- argv 元字符不经 shell（不生成副作用文件）。
- 非完整 40 位 SHA、argv 为空、minimumTests 与 timeoutMs 非法均拒绝。
- 临时目录清理。
- JUnit 计数解析与非法输入。

## 限制（未解决）

- 依赖与运行环境仍来自宿主（如 `node_modules` 未随 commit 导出），验证的是“被测代码内容来自该 commit”，不是完全隔离的环境。
- 被测试代码仍可在 commit 中包含问题；本验证器不替代代码审查。
- **尚未接入 Goal/任务完成门禁**，也未实现受保护的配置存储与写入权限；仅提供可被上层调用的验证函数与回执结构。V03 整体仍部分完成。
- 只有 Bun test 的 JUnit 输出在本仓库验证过，其他测试框架未验证。
