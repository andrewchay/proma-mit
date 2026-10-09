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
