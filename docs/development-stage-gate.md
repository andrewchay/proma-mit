# 开发阶段门禁（未完成模块切换）

## 为什么有这层门禁

发布版本里混入未调试完的功能，问题不在于分支管理，而在于**功能没有开关**。本门禁提供模块级开关，让未完成模块可以留在 `main` 上但不暴露给用户。

门禁与**订阅权益门禁**（`entitlement-gate.ts`）职责严格分离：

| 门禁 | 回答的问题 | 开放条件 | 权威来源 |
| --- | --- | --- | --- |
| 开发阶段门禁 | 功能做完了没有 | 我们宣布完成 | `main/lib/feature-gate.ts` |
| 权益门禁 | 用户买了没有 | 用户付费 | 服务端签发并验签的权益快照 |

最终可见 = 开发门禁放行 **且** 权益门禁放行。两者不要合并：合并后会出现“订阅了却打不开”或“没做完却能看到”这类无法归因的问题。

## 当前受管模块

以下四个模块处于 `hidden`（未完成，对所有用户不可见）：

| 模块 id | 覆盖视图 | 说明 |
| --- | --- | --- |
| `knowledge` | 知识库 | K0–K2 链路未调试完 |
| `marketing` | 达人 / 广告投放 / 能力中心 | 营销能力中心未调试完 |
| `outbound-sourcing` | 出海 sourcing | 买家发现与线索核验未调试完 |
| `proactive` | Proactive Center | 定时、监听、Routine、审批未调试完 |

项目管理（`projects`）与分析引擎（`analysis`）**不在管辖范围内**，未登记即不受限制，保持正常展示。

## 模块做完后如何放开

1. 打开 `apps/electron/src/main/lib/feature-gate.ts`。
2. 把对应模块的 `status` 从 `'hidden'` 改成 `'released'`。
3. 更新该模块的 `note`，说明已完成的范围。
4. 跑 `bun test feature-gate dev-gate` 与 `bun run typecheck`。

**不需要删除任何业务代码。** 改成 `released` 后不再受开发开关影响，直接进入正常可见流程；如果该模块另有订阅要求，则由权益门禁继续接管。

## 本地调试如何临时打开

在**非打包环境**下，把模块 id 写入 `~/.gravitas/settings.json`：

```json
{
  "enabledDevModules": ["proactive"]
}
```

- 可逐个开启，互不连带：只写 `proactive` 不会放开 `knowledge`。
- 修改后需重启应用生效。
- 只接受已登记的模块 id，未登记 id 会被忽略。

### 打包环境的强制约束

打包产物**忽略该字段**（`isPackaged` 时一律返回空）。原因是 `settings.json` 是本机可编辑文件，若不限制运行环境，任何用户改一行 JSON 就能解锁未完成功能，“默认关闭”就只是口头约定而不是机制保证。

即使有人在打包环境手动写入该字段，模块仍然不可见。

## 切分的落点

门禁在**两个层次**同时生效，避免“UI 藏了但接口还能调”：

- **渲染层**：侧栏入口、核心工作模块列表、主内容区视图三处统一按门禁过滤；旧持久化状态若停在未发布模块，回落到对话视图而不是白屏。
- **主进程**：未完成模块的 IPC 处理器**整体不注册**。未注册的通道调不通，比注册后再拒绝更彻底。

## 新增模块时

在 `feature-gate.ts` 的 `DEV_GATE_MODULES` 与渲染层 `dev-gate.ts` 的 `MODULE_VIEWS` 中登记，默认即 `hidden`。未登记的模块既不受门禁管辖，也不能被本地开关打开——`isModuleVisible` 会拒绝不在登记表内的 id。

## 相关测试

- `apps/electron/src/main/lib/feature-gate.test.ts`：默认全部隐藏、打包环境忽略开关、未登记 id 不可解锁、逐个开启不连带。
- `apps/electron/src/renderer/atoms/dev-gate.test.ts`：视图映射、兜底回落、项目管理与分析引擎不受影响。
- `apps/electron/src/main/lib/plugins/marketing-plugin.gate.test.ts`：既有权益门禁未被削弱。
