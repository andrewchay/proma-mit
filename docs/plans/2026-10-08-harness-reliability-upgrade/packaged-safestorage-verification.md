# 打包版 safeStorage 验证（待你执行）

脚本：`scripts/verify-packaged-safestorage.sh`（只读，不输出 API Key）。

## 你需要执行的步骤

1. 构建开发版验收包：`cd apps/electron && bun run dist:mac-dev-zip`
   （注意：本机只保留一个 Gravitas 版本，避免与正式版冲突。）
2. 运行脚本：`bash scripts/verify-packaged-safestorage.sh apps/electron/out/mac*/Gravitas.app`
3. 打开打包版应用，在设置中对一个已配置渠道执行“测试连接”。
4. 把脚本输出与第 3 步结果（成功或界面提示文字，不含密钥）告诉我。

## 说明

- 本脚本不能直接验证签名后的 `protected-verifier-store`：该存储目前没有 UI 入口，无法在打包版中触发。打包版中的渠道密钥使用同一 `safeStorage` API，因此“测试连接”成功可作为间接证据。
- 若需要直接验证签名存储，需要先实现设置界面（后续批次）。

## 结果（2026-10-09 16:42 GMT+8，用户在工作树打包版 0.12.126/0.12.127 上执行）

- 渠道“测试连接”成功：打包版可解密 safeStorage 中的 API Key。
- Bash 沙箱拦截 `/tmp` 写入（符合设计）。
- 发现并修复缺陷：会话目录位于配置目录下导致 git 无法 stat 父目录（0.12.127 修复，用户复测 `git add` + `git commit` 成功）。

限制：验证包为 ad-hoc 签名，正式签名版的钥匙串 ACL 行为仍需在有 Developer ID 证书的构建上重复验证。
