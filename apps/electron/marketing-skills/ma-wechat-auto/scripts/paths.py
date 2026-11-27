#!/usr/bin/env python3
"""统一解析运行目录。

脚本装在 `{工作区}/skills/ma-wechat-auto/scripts/` 下，而运行时数据
（台账 / 配置 / 基线 / 挂起队列 / 日志 / 截图）落在
`{工作区}/workspace-files/wechat-auto/state/`。

**为什么数据不放技能目录里**：内置技能升级时会整目录覆盖（rm + cp），
数据放技能目录下会被清空。workspace-files 是工作区持久目录，不受升级影响。
"""
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(SCRIPT_DIR)                    # {工作区}/skills/ma-wechat-auto
WS_ROOT = os.path.dirname(os.path.dirname(SKILL_DIR))      # 工作区根

STATE = os.path.join(WS_ROOT, "workspace-files", "wechat-auto", "state")

# 状态文件
LEDGER = os.path.join(STATE, "kol_ledger.csv")             # 达人台账
ADD_FRIENDS = os.path.join(STATE, "add_friends.csv")       # 加好友清单
BASELINE = os.path.join(STATE, "poll_baseline.json")       # 会话预览基线
CONFIG = os.path.join(STATE, "daemon_config.json")         # 守护进程配置
HOLDS = os.path.join(STATE, "holds.json")                  # 挂起队列（程序读）
HOLDS_MD = os.path.join(STATE, "holds.md")                 # 挂起队列（人读）
DAEMON_LOG = os.path.join(STATE, "daemon.log")
DAEMON_STDIO = os.path.join(STATE, "daemon.stdio.log")     # 后台运行时的 stdout/stderr（含崩溃堆栈）
FOLLOWUP_LOG = os.path.join(STATE, "auto_followup.log")
STOP_FILE = os.path.join(STATE, "daemon.stop")             # 停止标记
PID_FILE = os.path.join(STATE, "daemon.pid")               # 后台运行时的 pid
WINDOW_PNG = os.path.join(STATE, "wechat_window.png")      # 调试截图

# 话术来源：内置技能 ma-kol-outreach（与本技能同级装在 skills/ 下，各自升级互不影响）。
# 工作区若自建了同名技能，会用工作区那份（技能安装目录优先）。
PERSONA_SKILL = "ma-kol-outreach"
_SKILLS_ROOT = os.path.dirname(SKILL_DIR)                  # {工作区}/skills


def ensure_state():
    """确保 state 目录存在，返回其路径。"""
    os.makedirs(STATE, exist_ok=True)
    return STATE


def persona_path():
    """返回话术文件路径：本技能同级 skills/ma-kol-outreach/SKILL.md。"""
    return os.path.join(_SKILLS_ROOT, PERSONA_SKILL, "SKILL.md")
