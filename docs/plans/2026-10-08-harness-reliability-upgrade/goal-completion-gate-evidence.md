# Goal 完成门禁接入固定基线验证的证据

> 2026-10-09 12:00 GMT+8。基线 `9a3e7b99`。

## 行为

- `AgentGoal` 可选 `completionGate`（仓库绝对路径 + 固定基线验证配置）与 `completionVerification`（仅通过时写入的回执）。
- `GoalCoordinator` 注入验证函数，默认对仓库 **HEAD 提交**运行固定基线验证（`git rev-parse HEAD` 后 `git archive`），未提交内容不参与。
- 模型提交 `complete` 时：
  - 先校验检查点；有门禁则运行验证；
  - 验证期间若目标、门禁、调用身份或配置发生变化，拒绝完成；
  - 验证未通过，拒绝完成并把原因（如 `exit_code_unexpected`、`test_failures`）返回给模型，Goal 保持 active，等待修复后再次提交；
  - 通过才写入回执并置为 completed。
- 无门禁的旧 Goal 行为不变；`continue`、`blocked`、`waiting` 不触发验证。
- 门禁在创建时校验：仓库路径必须是绝对路径，验证配置必须合法（argv 非空、超时与最少测试数有界）。
- 门禁进入配置比较，验证途中被改写的门禁会被判定为配置漂移。

## 测试

- `goal-completion-gate.test.ts` 7 例：验证未通过拒绝且原因可见；通过后回执落盘（commit、计数、来源）；无门禁旧行为；continue/blocked 不触发；验证期间修改目标被拒；创建时拒绝非法门禁；真实临时 git 仓库，HEAD 已提交内容通过，未提交破坏不影响。
- 红灯：7 例中 2 例按预期失败（门禁未生效、回执缺失），随后修正夹具双重记录与既有“配置已变化”文本断言后绿灯。
- 相关四文件 19 expect、9 用例全部通过（gate、coordinator、invocation-context、pinned-baseline-verifier）。

## 未解决（见 protected-verifier-storage-design.md）

- **测试削弱缺口**：Agent 可以修改并提交测试文件，固定基线门禁无法识别。这是最需要决定的缺口。
- 门禁配置目前由 Goal 记录（JSON，本机私有文件信任），尚无受保护存储、签名或 UI。
- 尚无 UI 设置门禁；只能通过协调器 API 创建。
- 只支持 Bun test 的 JUnit 输出。
