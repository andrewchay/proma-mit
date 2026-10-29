# 文件工具路径替换竞态：局部证据

日期：2026-10-28；范围仅 Read / Write / Edit 三个工具入口，不代表其他工具、其他 Runtime 或跨进程文件系统隔离已通过。

## 缺口

三个工具此前都是"先按路径检查、再按路径使用"：检查与打开之间的父目录替换不会被发现。Edit 与 Write 打开后重查的是**路径**而不是已打开描述符的真实位置，"换出去再换回来"可以绕过；Read 完全按路径读取，窗口更大。

## 本次改动

- 新增 `assertDescriptorMatchesStat(descriptor, expected)`：比对已打开描述符与**打开前**捕获的 dev+ino。基准必须在打开前捕获——打开后再 stat 路径会跟随被替换后的父目录，失去检测能力。
- Read：先 `realpathSync` 目标并 `statSync` 固定 inode 基准，再打开，比对后再按规范化路径复核范围，随后从描述符读取。
- Edit：打开前以 `realpathSync(dirname)` 拼出预期路径并固定基准；打开、比对、范围复核后按描述符读写。原"打开后按路径重查"由更强校验替代。
- Write：新建文件不存在、无法打开前 stat，保留打开后 stat 预期路径比 inode（捕获"换出去再换回来"）并叠加规范化路径范围复核（捕获替换后持续指向外部）。
- 不用 `/dev/fd` 反查：实测 write-only 描述符在 macOS 返回 EACCES；dev+ino 与打开模式无关。

## 证据

- 新增 `path-race.test.ts`：用 mock 的 `realpathSync`/`statSync` 在"检查返回后、打开前"确定性地执行父目录替换。Read 用例断言拒绝且不泄露范围外内容；Write 用例断言拒绝且范围外文件未被改写；无竞态时读写行为不变；校验函数正反两个单测。5 项全部通过（可在受限宿主直接运行，不依赖 seatbelt）。
- 既有套件回归：`tool-impls.test.ts` 19 项通过（含硬链接、符号链接、多字节编辑用例），`tool-session-gate`、`tool-resources` 通过。唯一失败是 Bash 用例，原因为受限会话嵌套 `sandbox_apply` 返回 EPERM，与本改动无关。

## 边界

- 这是"检查—打开—确认"的二次校验，不是 `openat`/`RESOLVE_BENEATH` 级原子隔离；确认之后的读写都固定在已确认的 inode 上，但无法声称整个调用链对其他 Runtime 或内核级竞态原子。
- Grep、知识库工具、MCP 资源等其他文件入口未纳入本切片。
- Write 的"新建文件"路径仍依赖打开后的组合校验；如果替换发生在打开之前且替换后路径持续指向范围外，由范围复核拒绝，属正确行为但拒绝理由为"路径越界"。
- 未做真实 Electron 打包应用验证；测试为 Bun 运行时下的真实文件系统操作。
