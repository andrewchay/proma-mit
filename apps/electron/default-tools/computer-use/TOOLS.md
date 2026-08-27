# Computer Use 工具集

## 工具列表

### 状态查询（只读，无需额外权限）
| 工具名 | 用途 |
|--------|------|
| computer_use_status | 查询 Computer Use 权限状态 |
| computer_use_capabilities | 查询当前平台能力支持情况 |
| computer_use_displays | 枚举显示器信息（分辨率、坐标缩放） |
| computer_use_frontmost_application | 获取当前前台应用名称 |
| computer_use_frontmost_window | 获取当前前台窗口标题 |

### 控制操作（需要用户授权）
| 工具名 | 用途 |
|--------|------|
| computer_use_screenshot | 截取指定显示器屏幕 |
| computer_use_click | 在指定坐标点击鼠标 |
| computer_use_move | 移动鼠标到指定坐标 |
| computer_use_double_click | 在指定坐标双击鼠标 |
| computer_use_type | 输入文本或按键 |
| computer_use_scroll | 在指定坐标滚动鼠标 |
| computer_use_drag | 从起点拖拽到终点 |
| computer_use_key_combo | 执行键盘快捷键组合 |
| computer_use_request_permissions | 请求 Computer Use 权限 |
| computer_use_request_takeover | 请求用户接管（高风险操作前） |

## 使用策略

### 何时使用 Computer Use

**适合场景：**
- 用户明确要求"帮我操作电脑"、"点击某个按钮"
- 需要验证 UI 界面当前状态
- 需要截图查看屏幕内容
- 需要自动化重复性界面操作

**不适合场景：**
- 纯信息查询（优先使用 WebSearch）
- 文件系统操作（优先使用 Read/Write/Bash）
- 代码审查（委派 code-reviewer）
- 技术调研（委派 researcher）

### 权限管理流程

```
1. 首次使用 → 调用 computer_use_status 检查权限
2. 未授权 → 调用 computer_use_request_permissions 请求权限
3. 只读模式 → 只能使用状态查询 + screenshot
4. 完全模式 → 可以使用所有控制操作
5. 高风险操作 → 先调用 computer_use_request_takeover
```

### 标准操作顺序

**单步操作：**
```
1. 截图确认当前状态 → computer_use_screenshot
2. 执行操作 → click / type / scroll
3. 截图验证结果 → computer_use_screenshot
```

**多显示器场景：**
```
1. 获取显示器信息 → computer_use_displays
2. 指定显示器截图 → computer_use_screenshot (displayId)
3. 按对应坐标操作 → click (x, y, displayId)
```

### 安全规范（必须遵守）

- **绝不**在未经用户同意时执行点击、输入、拖拽等操作
- **绝不**输入敏感信息（密码、验证码、银行卡号等）
- **必须**在操作前截图确认当前状态
- **必须**在操作后截图验证结果
- **必须**在高风险操作前调用 request_takeover
- **禁止**执行可能导致数据丢失的操作（删除、格式化等）

### 坐标换算

截图返回的 `coordinateScale` 用于换算逻辑坐标和物理像素：
- 截图坐标 = 逻辑坐标 × coordinateScale
- 操作坐标 = 物理像素坐标（需除以 coordinateScale 得到逻辑坐标）

### 错误处理

- 权限不足 → 提示用户开启权限，不重复请求
- 坐标越界 → 检查 displays 信息，确认坐标范围
- 操作失败 → 截图确认当前状态，报告具体错误
