# Proma 扩展 SDK 契约（P2-4）

> 状态：契约草案（仅第一方内置插件可用，第三方 SDK 未开放运行时）
> 关联：`packages/shared/src/types/plugin.ts`（manifest/权限/生命周期类型）

## 目标

为未来签名第三方插件提供稳定契约。当前阶段：
- ✅ 第一方插件（灵动岛）通过 PluginManager 声明式管理
- ⬜ 第三方插件运行时加载（P2 后开放）
- 开放前必须先稳定：manifest 契约、权限模型、生命周期、安全边界

## 心智

> Skill 是方法，MCP 是连接，Tool 是动作，Workflow 是编排，**Extension 是可安装的产品扩展包**。

扩展可贡献：overlay 浮层 / 通知 / 菜单栏 / 设置页区块 / 文件预览 / Workflow 节点 / 外部连接。

## Manifest 契约（schemaVersion: 1）

```ts
interface PluginManifest {
  schemaVersion: 1
  id: string              // 反向域名，如 com.proma.dynamic-island
  version: string         // semver
  name: string
  description?: string
  publisher: string
  minHostVersion?: string
  platforms: PluginPlatform[]       // darwin / win32 / linux
  activationEvents: Array<'onAppReady' | 'onFirstTask'>
  subscriptions: PluginSubscription[] // app.started/progress/waiting_action/completed/failed
  surfaces: PluginSurfaceType[]
  permissions: PluginPermissions    // 声明式，UI 只读展示
  entrypoints: { runtime?: string; renderer?: string }
}
```

## 权限模型

声明式细分权限，**默认全部禁止**：

| 权限 | 说明 |
|---|---|
| events | 读取 Agent/Workflow 摘要事件 |
| sensitiveContent | 读取敏感正文（完整消息/文件路径） |
| overlay | 创建 Overlay 或系统通知 |
| openSession | 打开会话 |
| networkDomains | 受限网络域名白名单 |
| storage | 插件私有存储 |
| globalShortcut | 全局快捷键 |

**默认禁止**：文件系统、Shell、任意 IPC、渠道凭据、麦克风、Computer Use、主进程原生模块。

规则：
- 权限增加必须重新确认（升级时比对 approvedPermissions 快照）
- 补丁升级不得静默扩大权限

## 生命周期

```
discovered → installed(默认 disabled) → enabled → disabled
                 ↓ error（崩溃/权限不符）        ↑
                 └──────── uninstalled
```

- 连续崩溃自动隔离（指数退避）
- 崩溃插件重启有限次，超限放弃到下次任务

## 安全边界（不可妥协）

1. **第三方插件不能注入 Electron 主进程**，不能复用完整 `electronAPI`
2. 插件 UI 使用独立 sandboxed BrowserWindow/WebContentsView + 最小 preload
3. **原生能力由 Proma 签名的平台 adapter / 独立 helper 代理**（JSONL 协议），
   第三方原生代码不进入主进程、不继承 TCC/凭据
4. 事件 payload 按权限投影（不把完整 Agent message 发给插件）
5. 配置隔离：插件配置写自己目录，不碰宿主 settings
6. 零干扰宿主：插件失败/崩溃不影响主进程

## 第一方样板：灵动岛

`com.proma.dynamic-island`（macOS only）：
- surfaces: `overlay` + `settings`
- subscriptions: 五态全订阅
- permissions: `events` + `overlay` + `openSession`
- 启停联动：PluginManager → dynamic-island-service.setEnabled

它是「事件订阅 + surface + 平台降级」的完整参考实现：
- macOS：NSPanel 浮层（会话状态机）
- 无刘海：贴顶退化
- 非 mac / 关闭：系统通知降级（NotificationCoordinator）

## 开放第三方前的检查清单

- [ ] manifest schema 稳定（冻结 schemaVersion 1）
- [ ] 签名验证（插件包 hash + publisher 签名）
- [ ] 安装包格式（zip + manifest + 受限入口）
- [ ] sandbox 加载器（独立 WebContentsView + 最小 preload）
- [ ] 权限审批 UI（升级对比 approvedPermissions）
- [ ] 崩溃隔离与健康检查
- [ ] 兼容性测试矩阵（平台/宿主版本）
- [ ] 更新与回滚（原子切换）
