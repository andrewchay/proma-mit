# E02第六批子契约：文件资源观察性解析

> 2026-10-09 09:43 GMT+8用户继续；基线35ea1abc。

只实现E02的路径观察/保守分类，不启用锁、队列或并行，不修改既有execute/permissions/TCC。metadata与解析成功都不是执行授权。

## 输入与输出

- 从E01主进程实际注册实例取effects，不接受model的effects DTO。实际输入必须普通自有数据，file_path必须非空字符串无NUL；cwd必须自有绝对字符串且实际存在为目录。getter/继承/未注册/替换实例等回退unknown。
- 先复用resolveToolPath的既有范围校验；额外核验完整canonical target在real cwd内。不得把解析器当成可扩展工具授权范围的入口。
- 不存在的Write目标逐级检查existing ancestor，并保留全部缺失尾部重建canonicalPath。只有ENOENT允许向上；遇到悬空symlink、ENOTDIR、权限/其他错误或特殊节点不猜路径，回退unknown。
- Read/Edit只接受存在的普通文件；目录/特殊节点unknown。Write可接受普通文件或可明确重建的缺失目标；existing ancestor必须为目录。Write的scope仍path-and-ancestors，保守列出完整目标和祖先到root，不裁剪“当前已存在所以不会mkdir”的部分。
- 返回lexicalPath、canonicalPath、realCwd、existingAncestor、targetExists、dev/ino字符串身份（存在普通文件）、mode、scope与覆盖路径。符号链接canonical别名一致；硬链接可用dev/ino观察同文件身份。这里只观察，不生成lock key或凭据。
- 不做Unicode/casefold猜测；不同拼写和缺失目标的大小写别名不能现在称为已解决。现存目标可观察canonical path与inode，未来锁域还须保守覆盖。

## 保留边界

realpath/stat是非原子观察，外部进程/用户可能在之后换symlink、inode或目录，不能消除TOCTOU或证明无逃逸。普通文件类型也不证明虚拟filesystem没有读取副作用。没有跨session/进程锁域、实际并发、资源租约、重放或进程终止保证。

unknown必须由未来调度器走保守独占或拒绝路径，不能退回按descriptor.parallelSafe并行。E02整体、HR06–HR09/G2仍待验证；V02部分/V03来源阻塞保持。
