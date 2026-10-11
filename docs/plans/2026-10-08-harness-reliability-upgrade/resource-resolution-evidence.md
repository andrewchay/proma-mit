# E02第六批：文件资源观察性解析证据

> 截至2026-10-09 09:56 GMT+8；基线35ea1abc。见resource-resolution-contract.md。
> E02整体仍部分：无锁、队列、执行接线或默认并行。

## 落地

新增main agent-runtime/tool-resources.ts，复用E01实际注册实例及resolveToolPath既有范围校验，未修改任何execute/permissions。只对普通自有输入/cwd读取file_path；Getter、继承、DTO副本或失效实例unknown。

- cwd为现存绝对目录。保留lexicalPath并观察realCwd/canonicalPath。
- 对缺失Write目标，只在真正ENOENT时向上找现存目录，保留每段缺失尾部重建目标，不把多个新文件合并成一个ancestor。EACCES/ENOTDIR等不继续猜；悬空symlink以lstat识别并回退unknown。
- 完整真实目标再检查在cwd内。非规范绝对路径可能含未存在中间节点与../，不能照词法折叠伪称内核已经解析；保守unknown。相对路径保持既有工具的resolve词法语义，不扩大范围。
- Read/Edit要求现存普通文件；Write接受普通文件或可明确重建的缺失目标。目录/socket等不是普通文件，unknown。只Write的path-and-ancestors声明允许缺失；Edit的write/path不意味着可创建文件。
- 现存目标记录dev/ino字符串身份；symlink别名可观察同canonical目标，hardlink别名可观察同inode。Write覆盖目标及所有祖先到root，即使当前目标已经存在也不裁掉祖先范围；这不是授予根目录写权限。

## 验证

- red：新模块缺失，0pass/1fail/1error，为加载失败，未宣称25行为用例全部运行失败。
- 初次实现20pass；补充socket、非规范绝对路径、观察之后替换、EACCES与相对规则后最终25pass。四定向文件72pass/0fail，包含既有effects与tool-impls。
- 全仓547文件3699pass/0fail/27skip；九包typecheck、lint1978文件、docs:check与diff检查通过。
- 完整回归前后真实workspace目录名36→36完全一致、新增0；未读取真实配置文件内容。本批测试仅Node文件/链接与本地socket临时fixture，不导入应用配置/会话服务，不写真实配置；socket关闭、权限还原并清理目录。
- symlink/socket用例在Windows显式skip；EACCES用例在Windows/root身份skip。当前macOS运行新增25例全通过、无新增skip，不代表Windows真机验收。
- 私有harness-resources-{red,green,targeted,full-tests,typecheck}.log与前后目录清单位于会话工作台。统计不是可信测试回执，不替代14-case整体或G2。

## 保留限制

realpath/stat非原子；之后文件、link、inode或目录可能改变。普通文件类型也不证明虚拟filesystem没有读取副作用。未解决缺失目标的大小写/Unicode别名，没有读写锁、跨session/进程锁域、资源租约、队列取消/错误释放、重放、批次完整性或生产并行。

结果DTO只是观察，不应由模型提供或被调度端直接当安全凭据；未来调度必须在适当边界重新解析/核验，unknown保守独占或拒绝。没有消除TOCTOU、扩大权限或声称OS隔离。现有文件工具自身的路径处理没有被本批修复/替换。

V02仍部分、V03保护verifier/可信非零测试收集仍阻塞。未做TCC、真实Provider、付费、发布/build/package/native强停；原主工作树及README/AGENTS不动。E02/HR06–HR09/G2不标通过。

## 版本和简化

仅electron受影响：0.12.117→0.12.118；shared保持0.2.34，生成事实同步。无新依赖，无code-simplifier Skill，人工审查了真实祖先重建、错误分支和Write/Edit缺失区别。纯观察模块无生产caller，可独立回滚，不改变现有串行执行或数据存储。
