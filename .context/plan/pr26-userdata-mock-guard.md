# PR #26 Dev userData mock 兼容修复

## 现状
PR #26 当前 head `45fe87b0`。CI 已修正 package-smoke 专用 override，但全量 tests 仍在普通 Electron mock 导入时失败：源码 Dev 分支无条件 `app.setPath('userData', ...)`，mock 没有 `setPath`。

## 方案
- 在纯 `app-channel` 策略模块提取 userData override 选择逻辑。只有 Electron 提供 callable `setPath` 时才返回 userData 路径；package smoke 要求测试目录，源码 Dev 返回独立 Gravitas Dev appData 路径；Stable 默认不覆盖现有路径。
- main 入口按返回策略应用路径，并防御测试 mock。
- BDD 测试覆盖：源码 Dev 独立路径、Stable 保持原路径、package-smoke 临时路径、Electron mock 无 setPath 时不调用 API。
- 不以测试变量改变 packaged channel；不放宽自动副作用或网络边界。

## 步骤
1. 在当前分支精确暂存新策略/测试及 `index.ts` 修改，其他工作树改动保持不暂存。
2. 运行定向测试、Electron typecheck、Biome、renderer build、docs check、staged diff check。
3. 创建一个修复提交，仅推送 `feat/dev-stable-isolation`。
4. 等待 PR #26 必需检查；全绿后 merge #26。
5. #26 合并后让 PR #27 更新到新 main 基线，运行必需检查；全绿后再尝试 merge #27。
6. 任一必需检查失败则停止合并，报告失败来源，不绕过保护规则。

## 安全边界
- 保留当前 `feat/agent-input-ux` 工作树已有未提交/未跟踪更改。
- 不触碰生产 `~/.gravitas`，不退出应用。
- 不直接推送 main、不发布、不打 release tag。
