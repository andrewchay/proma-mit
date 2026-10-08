# STE插件合并前修复与验证

2026-10-08，针对PR20；先整合PR19的Owner/受控任务与lint基线，再整合授权旁路修复6808fda9。仅功能分支更新，不合并main，不安装用户应用，不运行真实Provider。

## 修复

- Pi/Claude编排不再用无法解析的`createRequire(__filename)('../plugin-manager')`；静态导入让打包器收录真实collector。
- Proma/AI SDK的最终系统提示构建器收集当前插件状态；普通子Agent角色提示也走同一构建器，保留角色、schema及工具指令。受控员工禁止子Agent的门禁不变。
- 插件直接使用typed settings服务，严格读取配置。配置读写失败不反馈成功；重复启停幂等成功。设置服务新增可选strictRead，其他调用保持既有默认兼容。
- 移除本仓库CLAUDE中的固定STE副本；停用插件不会再由该副本恢复规范。其他项目指令或用户自行写入的文风约束仍独立生效。
- 提示明确仅自然语言指导，schema/JSON/XML、事实、风险与安全优先；数字必须有证据，不能编造。不宣称提示词能硬性强制模型遵守。

## 离线证据

插件及组装测试使用临时PROMA_TEST_CONFIG_DIR，测试后清理并还原原环境；只替换无关插件/桌面宿主依赖，不替换STE、settings或manager。

- 真实manager启停、重复请求、坏JSON、写盘失败、目录读取失败与collector残留断言。
- Proma Adapter捕获6次最终Provider请求提示（默认与子Agent角色、启停），网络返回mock，无真实HTTP。
- AI SDK core捕获4次最终调用参数（默认/角色、启停），stream函数mock。
- Pi/Claude共用最终系统提示构建器接收真实collector，启停无STE残留；真实Pi/Claude SDK发请求及真实子会话spawn未验收，不把构建器测试等同端到端模型调用。

## 验证门禁与边界

首次540文件完整测试仅原生crash文件因新worktree冻结安装时跳过Electron安装脚本而失败；补齐已锁定Electron39.8.10后，6项Node/Electron原生WAL强杀回归全部通过。没有为此修改断言、跳过测试或安装新依赖版本。完整门禁与远端CI最终结果在本轮交付记录中收敛；真实Provider、费用、生产导航与安装不在本批验证范围。

包版本基于PR19新版本递增：Electron0.12.113/shared0.2.29；generated facts由脚本更新。PR20目前包含PR19历史，建议先合PR19，再合PR20；不将两份独立MERGEABLE误认为无需协调版本。
