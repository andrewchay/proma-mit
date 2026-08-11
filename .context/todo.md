# Gravitas Computer Use 插件化 + 配置门控 任务

## 背景
借鉴 Codex 的 Computer Use 设计（`computer-use@openai-bundled` 插件 + enterprise requirement 门控），
把 Gravitas（apps/electron 主进程）现成的 Computer Use 工具（screenshot/click/type 等）做成
「插件化 + 配置门控」。

## 进度
- [x] 探索工具注册与门控现状（tool-registry / ai-sdk-runtime-core / prompt-builder）
- [x] 探索权限系统现状（permission-rules / agent-permission-service）
- [x] 探索插件系统现状（plugin.ts / 插件实现 / BUILTIN_PLUGINS）
- [x] 设计方案并与用户确认选型（重量升级插件系统 + 分档门控 + 注册期 darwin 过滤）
- [x] 阶段A 插件系统升级到"能贡献工具"（agent-tools surface / computerUse 分档字段 / contributeTools / collectContributingTools）
- [x] 阶段B Computer Use 抽成插件（com.gravitas.computer-use + tool-registry 移除硬编码 + BUILTIN 注册）
- [x] 阶段C 分档配置门控（AppSettings.computerUse + 插件按 host 配置裁剪贡献 + 注册期 darwin 过滤）
- [x] 阶段D 测试 + 文档（computer-use-plugin.test 5 用例 + 26 测试回归 + CLAUDE.md）
- [x] 补充：settings-service 对 computerUse/feishuTodo 等嵌套对象深合并（避免子字段更新丢其它块）+ 4 个单测
      （修复了 updateSettings 浅合并丢字段的问题）
- [x] 风险加固（code-review 驱动）：
  - 僵尸开关修复：插件 isEnabled/setEnabled 委托 host settings.computerUse.enabled
  - 分档门控接通 UI：GET/SET_COMPUTER_USE_SETTINGS IPC + preload 桥 + AutomationSettings 三档"启用级别"
  - prompt 条件注入：AUTOMATION_TOOL_GUIDE 拆为 Web/记忆(恒) + Computer Use(仅 darwin 且 enabled)
- [x] 最终验证：38 相关测试全过 + shared/electron tsc + biome 通过

完成日期：2026-08-11
注：`runtime-routing-agent-adapter.test` 的 1 个失败为既有失败（DEFAULT_AGENT_RUNTIME='pi' 与测试期望 'claude' 不符），与本改动无关。
