# 非代码员工项目入口与本地验收包

截至2026-10-08。本批回应用户“实际应用看不到20个岗位模板、非研发员工不能参与项目”的要求。安装应用此前仍为0.12.104；源码与验收包为Electron0.12.109/shared0.2.27。未自动安装、替换、推送或调用真实Provider。

## 使用路径

1. AI团队中新建员工，选择20个岗位模板之一；填写实际启用渠道/模型，选择工作区。模板仅预填规则，不批量创建员工、不提供执行或费用授权。
2. 项目工作区中明确绑定该工作区。在“添加任务”选择“非代码 AI 任务”，选择实际controlled员工及项目/员工绑定交集的工作区。无Git、文件路径或研发决策必填。
3. 创建已指派的权威任务，首次落库即paused。准备动作没有execution、session、runner或模型调用；重复请求持久化去重。
4. 在任务行选择“预检并开始”，核对目标、说明、实际员工、渠道/模型、Runtime、工作区、safe/auto及权限申请，勾选模型费用确认。主进程重新核验后，一次确认绑定唯一execution，复用现有执行队列。
5. 配置或范围变化使原确认失效，重新预检。完成保持暂停、待人工验收，不把Agent完成当业务验收。

研发AI入口保留研发/Review/Pilot门禁；普通任务仍保留。受控非代码任务不开放Workflow、子任务适配、普通Agent或collaboration委派。本批不是Owner自动组织20个岗位、自动角色选择、预算grant或自主闭环。

## 确定性安全契约

- `controlled_task_preparations`与任务同SQLite事务保存创建幂等、确认指纹、范围指纹、首次准入时间及execution关联；`tasks.controlled_preparation_id`不可由普通编辑清除。
- 标记或按task_id的准备记录任一存在，中央派发即要求受控启动；缺标记、缺确认字段或身份不匹配拒绝，不自动补造授权。没有宣称能够抵御两份证据同时被直接删除的任意数据库篡改。
- 启动前复核真实身份、启用模型、员工及项目工作区绑定、依赖、Pilot冲突与配置指纹，queued→running条件认领先于会话创建。初始化、压缩、重试和每次模型发送前再次重读；明确工作区失效禁止回退到home。
- Pi的ModelRuntime主请求/内部摘要通过链式payload钩子和独立fetch出口；适配器自身压缩请求同样受控。强制SSE，不开放未经核验的deferred/images/classify请求路径。Google Pi SDK拒绝自定义fetch，因此启动预检明确拒绝该组合，不宣称它已可执行。
- AI SDK模型及各类压缩请求复用受控fetch出口。实际模型、渠道目的地、工作目录和权限与本次确认核对，主进程内部回调不能作为客户端授权标志。
- Pi读取实时工具权限；Plan可收紧，但恢复权限不能超出原确认。内部Plan出口、工具context setter及外部运行中权限切换都在修改状态前检查。受控父会话的中央子代理入口亦拒绝委派。
- 五分钟预检窗口约束首次准入及排队。已经准入的同一运行可在范围未变时继续，不误当整个任务五分钟上限；每次仍复核当前状态与范围。`provider_admitted_at`仅证明本地请求准入，不是Provider启动、费用或终态回执。
- 用户确认“可能收费”不是硬费用上限，safe/auto也不是OS沙箱。外发、写入等继续使用现有工具权限，不扩大Pilot或研发白名单。

## 验证分层

### 服务与SDK离线验证

新增服务19项测试通过，含79项之外新增外部权限切换断言，共82个expect：准备零执行、请求去重和数据库重开、非法身份/授权字段、绑定及员工变化、普通状态绕过、预检漂移、并发重复开始、真实mock runner完成待验收、损坏回执重开、HTTP出口参数漂移、真实Pi SDK的complete/completeSimple异步payload钩子期间变化零HTTP、合法模拟HTTP不误拦截、排队漂移、预检TTL与执行边界、真实Pi工具桥拒绝bypass/委派、AI SDK活跃adapter外部升级拒绝且写工具不执行。

所有模型输入与HTTP响应均是fake渠道/本地模拟，未连接真实Provider。全量`bun run test`逐文件隔离：537文件、失败0；真实Provider用例显式skip，不计真实验收。全工作区typecheck、改动TS/TSX定向Biome、模板生成一致性及原始角色静态校验通过。

全量lint仍有18个错误，涉及未修改的营销/视频模块与旧测试；对应文件经与本批开始HEAD逐字节比较一致。本批不扩改这些文件，不把完整PR lint门禁记为通过。

### 固定Electron组件与真实IPC

Electron39.8.10、产品preload/work模块handlers、原生better-sqlite3与真实React组件，在临时配置中验证：20模板可选→需求分析师controlled/safe保存→项目非代码任务指派且paused→预检费用确认默认禁用→产品普通updateTask IPC及真实auto-sync不能派发→数据库重开保留。

该验收使用独立窗口宿主适配，替换主index的窗口getter以免应用bootstrap；业务服务/IPC/数据库不mock，外围只读handlers亦调用产品服务。不是完整应用导航验收。临时数据清理，无生产员工创建。证据位于本次会话`noncode-entry-validation/`的native-result及三张PNG。

### 完整构建与实际安装包

完整main/preload/renderer及原生computer-use/dynamic-island/resources构建通过，Electron原生pty/sqlite重建通过。arm64 ZIP位于`apps/electron/out/Gravitas-0.12.109-arm64-mac.zip`，未签名、仅本地验收用途。

实际打包应用`package-smoke.ts`在临时配置启动通过：0.12.109、26工具、3核心默认Skills、分组停用、数据库重开与知识编辑；Kimi压缩显式未运行。单独检查asar中20个模板ID与规则哈希均已内嵌renderer，包内另附20模板原始JSON及完整MIT来源许可，没有夹带本次原生烟测入口。

安装替换与生产用户验收尚未完成。需要用户确认保存工作、停止任务、允许退出并替换现有应用，再一致备份并安装；不能据此说当前0.12.104已获得新入口。

## 存储与更新边界

准备/确认记录属项目SQLite权威数据；新表和marker列通过幂等迁移创建，不替换任务或execution表，不迁移既有员工。备份必须保留一致数据库、JSON/JSONL及关联配置。

写入新controlled员工或准备任务后，不得让旧0.12.104执行新数据；旧二进制可能把未知profile按general处理。不能只回换旧二进制降级，恢复需要用户同意的数据一致性方案。

## 仍未验证

真实Provider兼容、实际费用/终态、用户安装后完整导航、真实跨岗位协作与Owner自主计划/派发均未验收。授权规划、版本化计划持久化及AO-06等仍按Owner台账继续，不因本次人工受控入口标记完成。
