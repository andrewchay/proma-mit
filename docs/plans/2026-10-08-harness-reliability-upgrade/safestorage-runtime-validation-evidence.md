# 生产 safeStorage 运行时验证证据

> 2026-10-09 14:20 GMT+8。运行环境：仓库内 Electron 39.8.10（macOS，dev 二进制），应用名 `Gravitas`（与生产 productName 相同，复用现有钥匙串条目）。

## 方法

用 esbuild 将生产代码（`ProtectedVerifierStore` 与 `createSafeStorageKeyProtector`，**不使用**测试用异或保护器）打包为 CJS，由 Electron 执行。所有文件写入临时目录，不触碰真实 `~/.gravitas`。探针源码保存在会话工作台 `safestorage-probe/probe.ts`。

## 结果（修正探针自身的错误后的运行）

| 检查 | 结果 |
|---|---|
| `safeStorage.isEncryptionAvailable()` | true |
| 生产路径保存验证配置（修订 1，受保护路径 `**/*.test.ts`） | 成功 |
| 签名密钥文件 | 51 字节，前缀 `v10`（macOS safeStorage 密文），不是裸 32 字节密钥 |
| 新实例读取 | 成功；受保护路径与审计链有效 |
| 篡改记录内容（argv） | 被拒绝：`验证配置签名校验失败，拒绝使用` |
| 密钥密文末字节翻转 | 解密失败，失败关闭（无明文回退） |
| 还原密文后读取 | 成功 |
| 真实 `~/.gravitas/verifiers` | 未创建 |
| 钥匙串条目 `Gravitas Safe Storage` | 仍存在（未删除或改写） |

## 修正记录

第一次运行的 `keyFileLooksEncrypted=false` 与 `restoredKeyLoads` 失败，是**探针自身**用 `utf8` 读取二进制密文造成的（并把损坏的字节写回），不是存储模块的问题。改为 Buffer 读写后全部通过。

## 限制

- 验证的是 dev 版 Electron 二进制。正式签名应用的钥匙串 ACL 行为可能不同，需在打包版本中重复验证。
- 若 macOS 弹出钥匙串访问确认，属于用户侧操作；本次未观察到弹窗（该条目此前已由同名应用授权访问过）。
- 只验证了 macOS；Windows（DPAPI）与 Linux（Secret Service）未验证。Linux 无后端时 `isEncryptionAvailable` 为 false，存储按设计拒绝保存签名密钥。
