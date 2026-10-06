# 新媒体能力回滚手册

> 适用范围：Gravitas 新媒体运营能力（小红书 / 微信公众号）。
> 关联任务：P4-13。机制代码：`apps/electron/src/main/lib/new-media/new-media-feature-flags.ts`。
> 核对时间：2026-09-17。本手册描述的是**本机能力开关**；服务端多租户开关（P3-07）落地后需增补服务端操作步骤。

## 1. 能力清单与关闭影响

| 能力标识 | 控制范围 | 关闭后的表现 |
|---|---|---|
| `controlled-outbound` | 受控外发（发布 / 回复执行） | 已批准的动作无法执行，动作保持原状态；自动化排程触发生成的审批不受影响 |
| `content-operations` | 内容草稿、发布排程工具与 Skill | 插件不再注入对应工具；工作台草稿功能仍在（本地 UI 不经过插件） |
| `community-operations` | 互动导入与回复草稿工具 | 工具与 Skill 停止注入 |
| `social-listening` | 监听任务工具 | 工具与 Skill 停止注入 |
| `social-analytics` | 指标与报告工具 | 工具与 Skill 停止注入 |
| `trend-radar` | 热点雷达工具 | 工具与 Skill 停止注入 |
| `pugongying-data` / `juguang-ads` / `xiaohongshu-dm` / `licensed-listening` | 商业能力（P4-01） | 商业 Adapter 构造前断言失败，无法实现任何调用 |

## 2. 紧急回滚步骤（目标：1 分钟内完成）

```text
1. 打开 Gravitas > 新媒体运营 > 自动化 子视图（或调用对应 IPC）。
2. 写入 kill switch：
   setCapabilityFlag({
     capability: 'controlled-outbound',
     platform: 'wechat-official-account',   // 可选；省略则作用于全平台
     accountId: 'acc-xxx',                  // 可选；省略则作用于该平台全部账号
     stage: 'off',
     note: '故障原因（必填，便于事后追溯）',
     updatedBy: '操作人',
   })
3. 确认：执行中的受控动作会以「外发能力当前已被关闭」拒绝；已执行的不会回滚（平台侧需人工处理）。
```

关键事实：

- **关闭是即时的、代码路径最短**：执行器调用之前先查开关，不产生任何平台请求。
- **动作不丢失**：被拒绝执行的动作保持原状态，恢复开关后可直接重试。
- **审计不删除**：开关变更、动作审计全部保留，`restoreCapabilityFlag` 也不清理历史。

## 3. 恢复（回滚的回滚）

```text
restoreCapabilityFlag({ capability, platform?, accountId?, updatedBy: '操作人' })
```

- 恢复在对应作用域写入 `all` 阶段：若存在更宽作用域的 `off`（平台级），账号级 `all` 可以放行灰度账号。
- 若要恢复到「无覆盖」状态且存在平台级 `off`，需要同时恢复平台级开关。

## 4. 灰度发布流程

1. 新能力上线前先以 `allowlist` 阶段发布，名单内填入试点账号：
   `setCapabilityFlag({ capability, stage: 'allowlist', allowlist: ['acc-a'], updatedBy })`
2. 观察运行历史与审计（`listNewMediaAudit`）确认无异常。
3. 扩大名单或切 `all` 全量。
4. 发现异常回到第 1 步或直接 `off`。

## 5. 已知边界

- 开关快照为进程内缓存，插件工具注入路径读取最近一次快照；变更开关的同一进程内立即生效。
- 当前实现为**单机**语义。P3 服务端落地后，多租户开关必须在服务端执行（本地开关管不到其它设备），届时需在本手册增补服务端操作步骤与目标恢复时间（RTO）。
- 自动化排程规则不受 `controlled-outbound` 关闭影响（仍会生成待审批动作）；如需连审批生成一起停，用能力 `content-operations` / 对应 Skill 的开关或在自动化面板暂停规则。
