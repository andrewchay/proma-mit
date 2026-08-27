# 场景：首次使用 Computer Use

用户说：

> "帮我点击屏幕上的确认按钮。"

这是首次使用 Computer Use 功能。

请根据 TOOLS.md 中的权限管理流程，选择合适的工具并生成调用。

**期望行为：**
- 识别这是控制操作（click）
- 首次使用 → 先检查权限状态
- 调用 `computer_use_status`
- 若未授权 → 调用 `computer_use_request_permissions`
- 获取权限后再执行 click
