# E01第五批：文件effects实例元数据证据

> 截至2026-10-09 09:36 GMT+8；基线9d426f60。子契约见effects-contract.md。
> E01仍部分完成；没有开启并行，也未完成E02–E05或任何发布门禁。

## 落地范围

- shared context/tool-effects.ts提供v1资源引用声明、严格保守解析和静态独立读取候选判定。version/资源/scope/重放策略、未知字段、空/稀疏数组、隐藏/符号属性、继承与getter等不合规输入回退unknown。不调用声明getter或对象toString。
- RuntimeToolDefinition新增可选effects；core factory在前三个实际执行对象创建处绑定。主进程绑定只识别Read/Write/Edit准确name与已导入execute函数引用，不接收调用者自述的effects。
- Read为filesystem read/file_path/path，idempotent_read；Edit为write/path/never；Write现有实现会递归mkdir，所以write范围是path-and-ancestors/never。不能把目录创建缩减成单文件写入。
- 已有工具的弱引用实例元数据表保存独立冻结声明与name/execute/effects引用，不另建tool catalog。副本、序列化DTO、MCP提示和同名伪函数无绑定；已注册对象字段或执行入口替换后回退unknown。getter入口不被调用。返回值是独立副本。
- capability投影沿用已有descriptor，必须搭配真实注册实例。source非builtin、toolName不一致或access矛盾均unknown。parallelSafe=false只减少independentReadCandidate，不改变声明。无声明的旧工具仍能按原路径执行，只不获得读取候选资格。
- 实际Provider schema仍仅pick name/description/parameters；未加入effects或改变参数。既有Read/Write/Edit在临时目录执行行为、字段要求与偏移读取回归通过。

## 验证

- 新两套测试先red：模块缺失，各0 pass/1 fail/1 error，是加载失败而非已跑完所有行为用例。
- 实现后shared行为通过；main fixture先因不完整Electron mock的WebContentsView/dialog导出缺失而加载失败，改用已有buildElectronMock后通过。初次types发现测试字面量被扩大为number/string，改为literal后通过；这些fixture/类型错误不算行为成功。
- 最终新增main10例、shared20例。定向10文件73 pass/0 fail，包含既有tool-impls/capability摘要/投影回归。
- 全仓546文件3674 pass/0 fail/27 skip；九包typecheck、lint1976文件、docs:check与diff检查通过。工程测试统计不构成可信测试回执，也不替代独立14-case benchmark。
- 完整回归前后真实workspace目录名清单36→36完全一致、新增0；未读取真实配置文件内容。测试导入服务前设临时配置并恢复/删除，结束等待本地异步活动。日志私有harness-effects-{red,green,targeted,full-tests,typecheck}.log及目录清单位于本会话工作台。

## 保留边界

这些只是声明及main进程内实例关联，不是OS隔离、恶意同进程代码防护、对完整副作用的形式化证明或授权凭据。shared解析成功、source字符串、parallelSafe/readOnlyHint和DTO字段都不能直接授予调度/权限。

资源还只是file_path参数引用；尚未解析cwd/realpath/目录包含/共享锁域。Write祖先范围需保守处理，不能据此宣称不相交写入已经并行安全。未实现并发队列、跨进程锁、重试/取消释放、不完整调用批次保护或真实Runtime并行生产接线。Grep/网络/浏览器/终端/其他状态工具仍unknown，范围映射待后续核验。

没有权限变化、schema discovery、TCC实验、新flags、真实Provider、付费、外部发布、build/package/native强停。V02仍partial、V03的受保护verifier配置/可信非零测试收集仍blocked；本次effects声明不能绕过它们。

## 简化与回滚

无code-simplifier Skill，已人工审查：三类现有执行函数同源绑定，纯shared解析与main来源分开，复用catalog；不引入新依赖、能力目录或调度器。shared0.2.34/electron0.12.117与生成事实同步。README/AGENTS和原主工作树未修改。可回滚为无effects旧工具，保留原串行路径；下一步不得把回滚后的缺字段当作可并行。
