# Gravitas Dev / Stable 构建与发布验收

## 两个应用

| 项目 | Dev | Stable |
|---|---|---|
| 名称 | Gravitas Dev | Gravitas |
| Bundle ID | com.gravitas.app.dev | com.gravitas.app |
| 配置根 | ~/.gravitas-dev | ~/.gravitas（不迁移） |
| Electron userData | appData/Gravitas Dev | 原路径（不修改） |
| 协议 | gravitas-dev:// | gravitas:// |
| 本地构建输出 | apps/electron/out-dev | apps/electron/out |
| 更新 | 禁止正式更新；重新构建安装 | 正式更新渠道 |

源码启动属于 Dev；打包应用从自身 package.json 读取 gravitasChannel。环境变量不能修改安装包渠道。没有标记的旧安装包按 Stable 兼容处理，未知标记直接报错。

## 使用

在 apps/electron 目录：

```bash
bun run dev
bun run dist:dev
bun run dist:stable
bun run release:check
```

`dist:dev` 与 `dist:stable` 在 macOS 默认生成当前架构 DMG。跨平台可使用 `bun run scripts/dist.ts --dev --win --current-arch` 或 `--linux`，首次打包前执行既有 rebuild:natives。`--dev-unlock` 强制走 Dev 配置，开发身份本身不授予付费权益。

本地 dist.ts 总是 --publish never；实际 GitHub Release 仍由原 CI 发布，并先经过渠道契约、typecheck、测试、lint、文档事实校验。不要自动推 tag 或上传未验收产物。

## Dev 默认安全边界

- 不恢复 Goal、主动调度、Monitor、Pilot 后台执行、Workflow、自动评测、AI 员工心跳和项目自动同步。
- 不自动启动飞书/钉钉/微信、出海邮箱同步、Brief 回执、Companion 远程访问与全局快捷键。
- 保留手动会话、工具审批、事件总线和本地 RunStore。
- 更新初始化、检查和安装三个入口都拒绝访问正式更新渠道。
- 预览和第三方安装缓存使用 Dev 配置根内 cache；Stable 保留原临时目录。
- 备份导入不默认继承存在的外部路径，Dev 必须显式映射。

这是应用数据和后台启动隔离，不是网络沙箱。手动开启外部连接、手动发送或写入仍按既有权限处理。用户主动把同一目录授权给两版，仍可能发生文件冲突。不要复制生产配置根初始化 Dev；使用测试渠道和脱敏副本。

## 发布验收（全部通过才可称生产可用）

- [ ] 冻结 Git commit / tag，记录 package version。
- [ ] 全仓 typecheck、独立进程测试、lint、docs:check 通过。
- [ ] 新构建的安装包内 channel、bundle ID、名称、协议正确。
- [ ] Stable 构建中开发解锁标记没有注入；Dev 不包含正式更新配置。
- [ ] 不使用 PROMA_ALLOW_MULTI_INSTANCE：Stable→Dev、Dev→Stable 均可同时启动。
- [ ] 同一渠道的第二实例唤起原窗口，不新增写者。
- [ ] Dev 正常启动和清理，不修改 Stable 配置、缓存或会话。
- [ ] Dev Brief / Companion 使用系统分配端口；Companion 设置变更不绕过渠道策略自启。
- [ ] 退出时 Brief、Companion 与 Monitor 均停止。
- [ ] 到期任务/监听/外部连接夹具在 Dev 启动后不自动执行。
- [ ] 手动 Chat、Agent、工具审批与 RunStore 正常。
- [ ] Stable 占用 8765/8790 时，Dev 使用系统分配的非冲突端口并在界面/日志中可确认实际端口。
- [ ] Dev init/check/install 更新调用底层计数为零。
- [ ] Dev 导入不隐式继承生产外部目录。
- [ ] 上一正式版升级后会话/配置/凭据可用；重启可恢复。
- [ ] 升级前有备份，回退策略经过验证。旧安装包回退不保证数据格式回退。

现有 package-smoke 使用测试配置和多实例旁路，只能验证资源与离线核心流程，不能代替真实并存及正常 bootstrap 验收。不要为验收退出当前生产宿主，除非用户明确确认。
