---
name: ma-wechat-auto
version: "1.0.1"
description: 微信达人建联自动化（macOS + 微信 4.x 桌面版）。用「截图 → OCR 定位 → 坐标点击 + 剪贴板粘贴」操控微信：读会话、读消息（含语音转文字）、发消息、列会话、检测新回复，并以内置守护进程实现「全自动定时自动回复」（低风险话术自动发、报价/返点/档期/合同等敏感环节挂起等人工）。适用于"微信自动化/自动回复/自动跟发/自动定时回复/达人建联微信/给达人发微信/读微信消息/看达人回复/微信守护进程/微信消息轮询/建联进度跟踪"等场景。当用户提到微信自动发消息、自动回复达人、定时盯着微信回复、读取微信聊天记录、把达人微信消息汇总、微信建联跟进时触发。
---

# 微信达人建联自动化（ma-wechat-auto）

面向 **macOS + 微信 4.x 桌面版**。原理：坐标点击（`cliclick`）+ 按键注入（System Events）+ 截图 OCR（Vision）。
微信 4.x **不暴露辅助功能树**，所以不用"查找元素"，改用"截图 → OCR 定位 → 点击"。

## 何时使用

- 给达人发微信消息 / 批量发开场、邀约
- 读取某个达人会话的上下文（含语音转文字）
- 检测哪些达人回了消息（不打开会话、不抢焦点）
- **全自动定时自动回复**（守护进程，低风险自动发、敏感挂起）
- 达人建联进度的台账跟踪

## 前置条件

### 依赖
```bash
brew install cliclick
pip3 install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-Cocoa
pip3 install anthropic          # 仅"自动回复守护进程"需要
```

> 在 Gravitas 内使用可从「达人 → 触达 → 微信自动化环境」一键检测并安装。

### 系统权限（必须，缺一不可）
系统设置 → 隐私与安全性：
1. **辅助功能**：勾选运行本应用的终端 / Gravitas（用于注入键盘、鼠标事件、读取窗口）
2. **屏幕录制**：勾选同上（用于截图微信窗口）

> 授权后需**重启一次**对应应用。
>
> 判断是否授权成功：`python3 scripts/wx.py probe` 能输出截图路径且文件**大于 0 字节**。
> 若返回 `image object=None` 或生成 0 字节文件，就是屏幕录制权限没给。

### 微信侧准备
- 微信主窗口**保持打开**（不能只有菜单栏图标）
- **窗口尺寸必须 ≥ 700x500**：窗口过小时会话列表和输入框会被挤压，
  OCR 坐标过于密集，点击容易落到错误会话上——这种失败是「静默发错人」，
  不可逆。脚本检测到窗口过小会**直接拒绝执行**（退出码 2）并提示拉大窗口。
- 建议：设置 → 通用 → 发送消息，确认用 **Enter 发送**（脚本用 Enter）
- 登录的是**专用工作号**

### 配置项（`daemon_config.json`）

| 键 | 说明 |
|---|---|
| `api_key` / `base_url` | LLM 凭证。留空则回退到环境变量 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`（命令行直接跑时用）。Gravitas 内由宿主注入。 |
| `auto_send` | **自动发送总开关，默认 `false`**。未开启时即使 `risk=low` 也只生成草稿进挂起队列，由人工确认后手动发。 |
| `watch` | 观察的达人备注名列表，空则不处理 |
| `model` | 使用的模型 ID |
| `quiet_hours` | 免打扰时段，此区间内不发送 |

> ⚠️ **开启 `auto_send` 前请确认**：坐标点击没有兜底，发错人不可撤回。
> 建议先用 `--once --dry` 跑几轮，确认草稿质量和风险判定都符合预期后再开。

## 运行目录与数据文件

脚本装在技能目录，运行数据落在**工作区的持久目录**：

```
{工作区根}/skills/ma-wechat-auto/          # 本技能（升级会被整目录覆盖，不要放数据）
├── SKILL.md
├── references/
│   └── troubleshooting.md                # 踩坑记录（改脚本前必读）
└── scripts/
    ├── wx.py                             # 核心库 + CLI
    ├── auto_daemon.py                    # ★ 自动回复守护进程
    ├── poll_replies.py                   # 轮询新消息并读对话（不发送）
    ├── auto_followup.py                  # 开场后监测回复并自动跟发一句
    ├── check_new.py                      # 新消息检测（对比预览）
    ├── test_decision.py                  # 合成对话验证风险分级（不碰微信）
    ├── wx_probe.py / wx_ocr.py           # 窗口探测 / OCR 坐标标定
    └── paths.py                          # 统一路径解析

{工作区根}/skills/ma-kol-outreach/SKILL.md # 话术唯一来源（独立的内置技能）

{工作区根}/workspace-files/wechat-auto/state/   # 运行数据（不受技能升级影响）
├── daemon_config.json                    # 守护进程配置
├── kol_ledger.csv                        # 达人台账
├── add_friends.csv                       # 加好友清单
├── poll_baseline.json                    # 会话预览基线
├── holds.json / holds.md                 # 挂起队列（程序读 / 人读）
├── daemon.log / auto_followup.log
├── daemon.stdio.log                      # 后台启动时子进程的 stdout/stderr（含崩溃堆栈）
├── daemon.pid / daemon.stop              # 后台运行时的 pid / 停止标记
└── *.png                                 # 调试截图
```

**话术单一来源**：读同级技能 `skills/ma-kol-outreach/SKILL.md`（品牌话术，先改它的第一节）。
守护进程与 agent 读同一份，**改话术只需改一处**；工作区若自建同名技能则优先读工作区那份。
话术文件缺失时 `--status` 与启动日志会直接报错路径。

**台账列**（`kol_ledger.csv`）：`达人昵称,微信号,加好友状态,对话阶段,上次预览,最后互动,备注`
**加好友清单列**（`add_friends.csv`）：`达人昵称,微信号,验证语`
**守护进程配置字段**：`watch`(观察名单) / `interval_seconds` / `interval_jitter` / `reply_delay_seconds` / `n_messages` / `model` / `quiet_hours` / `max_rounds`

## 命令速查

> **路径约定（重要）**：Agent 的 cwd 是**会话目录**，不是技能目录。
> 因此调用脚本必须用**绝对路径**：`{工作区根}/skills/ma-wechat-auto/scripts/<脚本名>`。
> 命令以 `python3 ` 开头、不带 `cd` / `&&` / 管道前缀，以便命中 `Bash(python3 *)` 放行规则（见下方"运行权限注意"）。

```bash
# 场景 / 窗口
python3 <技能>/scripts/wx.py probe                 # 探测窗口并截图
python3 <技能>/scripts/wx.py ocr                   # OCR 全窗口（含屏幕坐标）
python3 <技能>/scripts/wx.py sessions              # 列出会话列表

# 读 / 发
python3 <技能>/scripts/wx.py read "达人备注名" 12            # 读最近 12 条（←对方 →我方）
python3 <技能>/scripts/wx.py read "达人备注名" 12 --voice     # 同上，先把可见语音转成文字
python3 <技能>/scripts/wx.py voices                        # 只做「语音转文字」，返回转换条数
python3 <技能>/scripts/wx.py send "达人备注名" "你好"          # 发消息（发送前校验会话已打开 + 文字已进输入框）

# 检测 / 轮询
python3 <技能>/scripts/check_new.py                # 检查已添加达人是否有新消息
python3 <技能>/scripts/poll_replies.py             # 轮询新消息并读对话（不发送）
python3 <技能>/scripts/poll_replies.py --json      # JSON 输出，供程序消费
python3 <技能>/scripts/auto_followup.py --message "在的宝儿～" --minutes 30 "达人A" "达人B"
```

## 自动回复：全自动定时（守护进程）★

`scripts/auto_daemon.py` 是**独立 Python 守护进程，不依赖 MAPro 开着**。

### Agent 如何植入（推荐路径）

Agent 的 Bash 工具是**同步的、默认 30 秒超时**，不能直接前台托管常驻进程（会超时被杀）。
因此守护进程提供 `--start` **自我脱离终端**（`start_new_session`，父进程立即返回），
Agent 只负责**启停 + 状态巡检 + 处理挂起队列**：

```bash
# 1) 先演练一轮（只生成草稿 + 挂起，绝不发送）——务必先跑这个
python3 <技能>/scripts/auto_daemon.py --once --dry

# 2) 后台启动（立即返回，进程独立存活，MAPro 关掉也继续跑）
python3 <技能>/scripts/auto_daemon.py --start

# 3) 状态巡检（pid 存活 + 话术来源 + 最近 5 行日志）
python3 <技能>/scripts/auto_daemon.py --status

# 4) 停止（后台运行发 SIGTERM，正常 5 秒内退出；前台运行写停止标记）
python3 <技能>/scripts/auto_daemon.py --stop
```

**Agent 的典型职责**：
1. 启动前先确认 `state/daemon_config.json` 的 `watch` 名单正确、`ANTHROPIC_*` 环境变量已配置
2. 先 `--once --dry` 演练，把 `holds.md` 给用户看
3. 用户确认后 `--start`
4. 后续会话里用 `--status` + 读 `state/holds.md` 汇报"哪些达人回了、哪些挂起待确认"
5. 用户要停就 `--stop`

### 每轮做什么

检测新消息 → `read --voice` 读对话 → 调 LLM（以话术文件作系统提示）→
返回 JSON `{stage, risk, reply, note}` → **`risk=low` 自动发**（带随机延迟模拟真人）；**`risk=high` 写入挂起队列**。

- **挂起队列**：`state/holds.md`（人读）+ `state/holds.json`（程序读）——报价 / 返点 / 档期 / 合同 / 转账一律进这里，等人工确认
- **日志**：`state/daemon.log`

### 安全设计
低风险白名单（破冰 / 介绍 / 邀约 / 索要报价表 / 收到报价表 / 内部反馈 / 闲聊）；静默时段不跑（免得半夜秒回像机器人）；发送前随机延迟；每轮间隔带 ±30% 抖动。风险分级契约见话术文件第八节。

### ⚠️ 启动前必须确认
- 此刻**用户不用微信**（会周期性抢焦点、注入点击）
- `watch` 名单正确
- 已跑过 `--once --dry` 演练

## 手动流程（不跑守护进程时）

1. `check_new.py` 发现达人有新消息
2. `wx.py read "<昵称>" 12 --voice` 读上下文
3. 按话术文件判断阶段生成回复
4. 敏感环节挂起，其余 `wx.py send` 发送
5. 更新台账

## 加好友（半自动，人工）

微信对"按号搜索 + 批量添加"风控极严，且 Mac 本机自动化做不稳，故**加好友走人工**：

1. 打开 `state/add_friends.csv`，里面有微信号 + 个性化验证语
2. 手动在微信里搜索添加，验证语直接复制
3. 添加成功后，把台账 `kol_ledger.csv` 里该达人的「加好友状态」改为 `已添加`，并把「达人昵称」改成**微信里的备注名**（会话列表匹配用）
4. 节奏控制：每天 ≤20 个，间隔几分钟，别一次加完

## 运行权限注意（重要）

- **Auto 模式限制**：claude runtime 的 auto 模式下，SDK 内置 LLM 分类器可能拦截"向真实平台发送外部消息"类脚本（判定不稳定，时拦时不拦）。
- **放行方案**（`~/.claude/settings.json` `permissions.allow`）：`"Bash(python3 *)"` 命中直接以 `python3 ` 开头的命令（前缀匹配即放行）。
- **必须遵守**：命令以 `python3 ` 开头，路径用绝对路径但**不要带 `cd` / `&&` / 管道前缀**，否则前缀不匹配会落入 LLM 分类器。
- **兜底**：若仍被拦，让用户自己运行脚本并把输出发给 Agent 确认；或切换非 auto 模式（逐条询问）。

## 铁律

1. **绝不要在用户正在用微信时跑自动化** —— 脚本会激活微信、注入点击与 `⌘V` 粘贴，与手动操作互相打架（可能把正在编辑的草稿发出去、或点错会话）。跑之前先确认用户可交出控制权。
2. **金额 / 承诺一律挂起** —— 报价结论、返点数字、档期承诺、提报结果、寄样 / 合同 / 结款，全部 `risk=high` 等人工。
3. **不要用右键菜单** —— 微信 4.x 对 `cliclick` 右键不响应，撤回 / 转发无法自动化。
4. **改脚本前先读** `references/troubleshooting.md`（18 条实测踩坑）。

## 相关

- 达人建联话术：`ma-kol-outreach`（**话术唯一来源，先改它的第一节品牌信息**）
- 蒲公英平台邀约与微信号提取：`ma-pgy-invite`
- 达人数据采集：`ma-kol-scraper`
- 发布后数据追踪：`ma-publish-data-track`
