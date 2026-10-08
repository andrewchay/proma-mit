# Owner计划版本／单任务目标：验证记录

发生/截至：2026-10-08 21:36 GMT+8。分支`feat/ai-project-owner`，基线已合并main `6c71b384`；源码Electron0.12.114/shared0.2.30。当前片只有目标入口与无费用计划版本服务，不是主动规划／派发闭环，不更改AO-G0～G3未通过结论。

## 工程与确定性证据

| 验证 | 本次结果 | 范围 |
|---|---|---|
| 计划服务 | 17通过／106断言 | 双CAS、来源/岗位变化、非法内容/授权字段、损坏历史/身份、回滚/重开/旧库、零派发事件 |
| 计划IPC | 5通过／39断言 | 5路严格IPC、固定actor、结构化冲突、主体及执行/预算表不变 |
| 单任务入口 | 3 SSR/状态/源码接入测试＋1 Chromium交互测试通过 | Jotai懒加载、真实组件输入/切任务/保存/重开Dialog、小窗；浏览器API替身不是IPC |
| 全仓类型检查 | 全部package通过 | 最终源码版本，不同树结果不混用 |
| 全仓测试 | 544独立文件，失败0 | `bun run test`分文件进程及临时配置；真实Provider及外部服务用例显式skip，不记已通过 |
| 全仓lint | 1974文件，无错误/警告 | 未放宽规则或增加suppression |
| 文档／diff／模板 | 通过 | docs:check、diff --check、20模板生成一致性与来源验证；modelBehaviorEvaluation仍not-run |
| 完整build | 通过 | 全workspace＋renderer/main/preload/resources，macOS两个原生helper编译成功；不是打包/安装验收 |

首次服务BDD RED为模块不存在，后GREEN；所有新存储回归仅临时目录。源码组件已做简化核对：复用既有GoalPanel/atoms，独立小入口，不复制TaskItem；shared统一计划契约，服务中分开来源/历史/命令校验，无Provider/任务派发依赖。未添加依赖。

## 固定Electron／真实IPC／原生数据库

2026-10-08 21:36 GMT+8本次最终回执`runId=42eb856c-b914-4dd2-a605-2f7ca2d2383c`，`success=true`、exitCode0。父已核对回执、源码hash、生产preload起止hash与截图。

- Electron39.8.10、Node22.22.1、ABI140。
- better-sqlite3 13.0.3原生`darwin-arm64.node`，SQLite3.53.4／WAL／NativeSqliteCompat；不是sql.js替身。
- 32次真实IPC：源码TaskOwnerGoalEntry/GoalPanel/Jotai→实际产品`dist/preload.cjs`→真实goal/plan registrar与数据库。
- 任务A/B目标打开、输入、保存、冲突保留、人工比较后保存；项目/任务身份隔离。
- 计划来源指纹、未知字段、非法岗位和旧修订拒绝；真实IPC验证内容指纹篡改、非法连续历史转换拒绝，临时夹具恢复。
- 数据库关闭重开及全新BrowserWindow/Jotai经IPC回读目标、计划、历史；任务内容与非Owner业务表计数不变。任务2、员工/execution/Pilot commands/grants/chain revisions均0。
- 零HTTP请求、零真实模型调用。临时配置已在finally移除，原环境保留。
- 360×480 viewport：Dialog `(16,16,328,448)`，无横向/视口溢出，内部滚动；截图经过核对。

**固定指纹：**

- plan-service源码SHA256：`139cd166246ae9e648fb176d4c4e216fe6ee3780aa77e52632cc6c5a746067a7`。
- 产品preload起止SHA256：`ba4d38d14635632cb17685decf245a0ad6bcaebe469ff1f8139b5c7fdd38fedd`。
- 原生binding SHA256：`98e0e8acd01c632fe5615243e1296af0372826f8783b18fc31c506f73c47459c`。

机器回执、构建输入/源码hash、运行日志、截图和可重跑harness保存在会话工作台`owner-plan-native-validation/`；不将本机路径/临时配置夹具作为产品资源打包。

## 明确未验证

1. 独立Electron host，不启动完整产品main/后台；TaskItem接入有源码回归，但完整生产导航和安装包未验收。
2. 计划操作经真实preload API；无计划UI，更无Owner模型生成、澄清或主动推进。
3. `origin=manual`，确认仅认可内容，不构成执行/费用或外发授权。真实Provider、费用回执与底层进程终止均未测试。
4. 覆盖数据库关闭重开和新renderer，不等于完整应用进程重启、断电恢复或多进程争用。
5. 不创建生产员工、不升级/替换正在使用的0.12.109、不发布、不合main。原main及用户本地日志/备份保持原状。

下一片：明确Owner身份/代码角色与配置继承、复用调用控制面的规划费用/资料授权及发送前复核，再接Owner主动模型提案和可编辑计划。计划版本存储／人工内容确认不是这些功能的替代。
