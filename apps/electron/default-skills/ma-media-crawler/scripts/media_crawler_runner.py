#!/usr/bin/env python3
"""ma-media-crawler 包装器：把标准化 JSON 配置转给 MediaCrawler 执行并整理产物。

用法：
    python3 media_crawler_runner.py --config <path/to/config.json>

输出（stdout 最后一行，JSON）：
    {
        "success": true,
        "record_count": 1,
        "comment_count": 15,
        "output_file": "/abs/path/to/output.csv",
        "log_file": "/abs/path/to/run_xxx.log"
    }
"""

import argparse
import datetime
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# Skill 根目录：scripts/ 的父目录
SKILL_DIR = Path(__file__).resolve().parent.parent
MEDIA_CRAWLER_DIR = SKILL_DIR / "MediaCrawler"
BASE_CONFIG_PATH = MEDIA_CRAWLER_DIR / "config" / "base_config.py"
BASE_CONFIG_BACKUP_PATH = MEDIA_CRAWLER_DIR / "config" / "base_config.py.bak"

# 默认输出目录：当前工作目录下的 workspace-files/ma-media-crawler
DEFAULT_OUTPUT_DIR = Path.cwd() / "workspace-files" / "ma-media-crawler"


def log(msg: str, log_file=None):
    line = f"[{datetime.datetime.now().isoformat(timespec='seconds')}] {msg}"
    print(line)
    if log_file:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def fail(reason: str, log_file: Optional[Path] = None) -> None:
    log(f"ERROR: {reason}", log_file)
    result = {"success": False, "error": reason}
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(1)


def check_port_open(port: int, host: str = "127.0.0.1", timeout: float = 2.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def ensure_media_crawler_exists() -> None:
    if not MEDIA_CRAWLER_DIR.exists():
        raise FileNotFoundError(
            f"MediaCrawler 子模块不存在: {MEDIA_CRAWLER_DIR}\n"
            "请运行: git submodule update --init --recursive"
        )
    if not (MEDIA_CRAWLER_DIR / "main.py").exists():
        raise FileNotFoundError(
            f"MediaCrawler 目录不完整，缺少 main.py: {MEDIA_CRAWLER_DIR}"
        )


def normalize_xhs_note_url(raw_id: str) -> str:
    """把用户输入的 note_id 或 URL 统一成 MediaCrawler 可解析的笔记 URL。"""
    raw = raw_id.strip()
    if not raw:
        return raw
    # 如果已经是完整 URL，直接返回
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    # 纯 note_id，构造标准 URL（xsec_token 留空，MediaCrawler 会走 HTML 兜底）
    return f"https://www.xiaohongshu.com/explore/{raw}"


def override_base_config(overrides: Dict[str, str]) -> None:
    """通过字符串替换临时覆盖 base_config.py 中的配置项，执行前调用。"""
    if not BASE_CONFIG_PATH.exists():
        raise FileNotFoundError(f"base_config.py 不存在: {BASE_CONFIG_PATH}")

    # 先备份
    shutil.copy2(BASE_CONFIG_PATH, BASE_CONFIG_BACKUP_PATH)

    content = BASE_CONFIG_PATH.read_text(encoding="utf-8")

    # 支持的覆盖项：变量名 -> 新值的 Python 字面量字符串
    for var_name, new_value in overrides.items():
        # 匹配类似：PLATFORM = "xhs" 或 ENABLE_CDP_MODE = True
        pattern = rf"^(\s*{re.escape(var_name)}\s*=\s*).*?($\n)"
        replacement = rf"\g<1>{new_value}\g<2>"
        new_content, count = re.subn(pattern, replacement, content, count=1, flags=re.MULTILINE)
        if count == 0:
            # 如果没找到，在文件末尾追加
            new_content = content + f"\n# ma-media-crawler override\n{var_name} = {new_value}\n"
        content = new_content

    BASE_CONFIG_PATH.write_text(content, encoding="utf-8")


def restore_base_config() -> None:
    """恢复 base_config.py 备份。"""
    if BASE_CONFIG_BACKUP_PATH.exists():
        shutil.move(BASE_CONFIG_BACKUP_PATH, BASE_CONFIG_PATH)


def build_command(cfg: Dict, work_dir: Path) -> List[str]:
    """根据配置构建 MediaCrawler 命令行。"""
    platform = cfg["platform"]
    task_type = cfg["type"]

    # MediaCrawler 的 lt 参数只支持 qrcode/phone/cookie；CDP 模式通过
    # base_config 中的 ENABLE_CDP_MODE=True 开启，因此这里固定用 qrcode。
    cmd = [
        "uv", "run", "main.py",
        "--platform", platform,
        "--lt", "qrcode",
        "--type", task_type,
        "--save_data_option", "csv",
        "--headless", "false",
    ]

    if task_type == "detail":
        urls = [normalize_xhs_note_url(i) for i in cfg["ids"]]
        cmd += ["--specified_id", ",".join(urls)]

    cmd += ["--get_comment", "true" if cfg.get("enable_get_comments", True) else "false"]
    cmd += ["--get_sub_comment", "true" if cfg.get("enable_get_sub_comments", False) else "false"]
    cmd += ["--max_comments_count_singlenotes", str(cfg.get("max_comments", 20))]
    cmd += ["--crawler_max_notes_count", str(len(cfg.get("ids", [])))]
    cmd += ["--max_concurrency_num", "1"]

    return cmd


def find_generated_csv_files(work_dir: Path, platform: str, task_type: str) -> Tuple[Optional[Path], Optional[Path]]:
    """在 MediaCrawler 默认输出目录中查找生成的 contents/comments CSV。"""
    csv_dir = work_dir / "data" / platform / "csv"
    if not csv_dir.exists():
        return None, None

    today = datetime.date.today().strftime("%Y%m%d")
    contents_file = csv_dir / f"{task_type}_contents_{today}.csv"
    comments_file = csv_dir / f"{task_type}_comments_{today}.csv"

    return (
        contents_file if contents_file.exists() else None,
        comments_file if comments_file.exists() else None,
    )


def merge_contents_and_comments(contents_csv: Path, comments_csv: Path, output_file: Path) -> int:
    """把 contents 和 comments 两张 CSV 按 note_id 合并成一张宽表，返回记录数。"""
    import csv

    # 读取所有评论并按 note_id 分组
    comments_by_note: Dict[str, List[Dict]] = {}
    with open(comments_csv, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            note_id = row.get("note_id", "")
            comments_by_note.setdefault(note_id, []).append(row)

    # 把评论列表序列化为可放入 CSV 的字符串（JSON 数组）
    def serialize_comments(comments: List[Dict]) -> str:
        # 只保留关键字段，避免列太宽
        simplified = []
        for c in comments:
            simplified.append({
                "comment_id": c.get("comment_id", ""),
                "create_time": c.get("create_time", ""),
                "content": c.get("content", ""),
                "like_count": c.get("like_count", ""),
                "sub_comment_count": c.get("sub_comment_count", ""),
                "nickname": c.get("nickname", ""),
            })
        return json.dumps(simplified, ensure_ascii=False)

    with open(contents_csv, "r", encoding="utf-8-sig", newline="") as fin:
        reader = csv.DictReader(fin)
        fieldnames = reader.fieldnames or []
        # 如果原始 contents 没有评论相关字段，追加
        extra_fields = ["comments_json", "comment_count"]
        out_fieldnames = fieldnames + [f for f in extra_fields if f not in fieldnames]

        with open(output_file, "w", encoding="utf-8-sig", newline="") as fout:
            writer = csv.DictWriter(fout, fieldnames=out_fieldnames)
            writer.writeheader()
            count = 0
            for row in reader:
                note_id = row.get("note_id", "")
                comments = comments_by_note.get(note_id, [])
                row["comments_json"] = serialize_comments(comments)
                row["comment_count"] = str(len(comments))
                writer.writerow(row)
                count += 1

    return count


def main():
    parser = argparse.ArgumentParser(description="ma-media-crawler runner")
    parser.add_argument("--config", required=True, help="path to config JSON")
    args = parser.parse_args()

    config_path = Path(args.config).resolve()
    if not config_path.exists():
        print(json.dumps({"success": False, "error": f"配置文件不存在: {config_path}"}, ensure_ascii=False))
        sys.exit(1)

    with open(config_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    # 校验最小字段
    if cfg.get("platform") != "xhs":
        print(json.dumps({"success": False, "error": "Phase 1 仅支持 platform='xhs'"}, ensure_ascii=False))
        sys.exit(1)
    if cfg.get("type") != "detail":
        print(json.dumps({"success": False, "error": "Phase 1 仅支持 type='detail'"}, ensure_ascii=False))
        sys.exit(1)
    if not cfg.get("ids"):
        print(json.dumps({"success": False, "error": "缺少 ids 字段"}, ensure_ascii=False))
        sys.exit(1)

    output_dir = Path(cfg.get("output_dir") or DEFAULT_OUTPUT_DIR).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    output_filename = cfg.get("output_filename") or f"xhs_detail_{timestamp}.csv"
    output_file = output_dir / output_filename
    log_file = output_dir / f"run_{timestamp}.log"

    log(f"启动 ma-media-crawler，配置: {config_path}", log_file)

    try:
        ensure_media_crawler_exists()
    except FileNotFoundError as e:
        fail(str(e), log_file)

    # 检查 CDP
    cdp_port = cfg.get("cdp_port", 9222)
    if not check_port_open(cdp_port):
        fail(
            f"无法连接到 Chrome CDP 端口 {cdp_port}。"
            "请确保 Chrome 已使用 --remote-debugging-port={cdp_port} 启动。",
            log_file,
        )

    # 构建命令
    cmd = build_command(cfg, MEDIA_CRAWLER_DIR)
    log(f"执行命令: {' '.join(cmd)}", log_file)
    log(f"工作目录: {MEDIA_CRAWLER_DIR}", log_file)

    # 覆盖 base_config 中的 CDP 端口与连接模式
    config_overrides = {
        "CDP_DEBUG_PORT": str(cdp_port),
        "CDP_CONNECT_EXISTING": "True",
        "ENABLE_CDP_MODE": "True",
        "AUTO_CLOSE_BROWSER": "False",  # 不要关掉用户自己的 Chrome
        "SAVE_DATA_OPTION": '"csv"',
        "ENABLE_GET_COMMENTS": "True" if cfg.get("enable_get_comments", True) else "False",
        "ENABLE_GET_SUB_COMMENTS": "True" if cfg.get("enable_get_sub_comments", False) else "False",
        "CRAWLER_MAX_COMMENTS_COUNT_SINGLENOTES": str(cfg.get("max_comments", 20)),
        "CRAWLER_MAX_SLEEP_SEC": str(cfg.get("crawler_max_sleep_sec", 2)),
        "MAX_CONCURRENCY_NUM": "1",
    }

    try:
        override_base_config(config_overrides)
    except Exception as e:
        log(traceback.format_exc(), log_file)
        fail(f"覆盖 MediaCrawler 配置失败: {e}", log_file)

    try:
        # 运行 MediaCrawler
        env = os.environ.copy()
        # 强制 UTF-8，避免 Windows/macOS 终端中文乱码
        env["PYTHONIOENCODING"] = "utf-8"

        with open(log_file, "a", encoding="utf-8") as log_fh:
            process = subprocess.run(
                cmd,
                cwd=MEDIA_CRAWLER_DIR,
                env=env,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )

        if process.returncode != 0:
            fail(f"MediaCrawler 进程退出码 {process.returncode}，请查看日志: {log_file}", log_file)

        # 查找产物
        contents_csv, comments_csv = find_generated_csv_files(
            MEDIA_CRAWLER_DIR, cfg["platform"], cfg["type"]
        )

        if not contents_csv:
            fail(f"未找到生成的 contents CSV，请查看日志: {log_file}", log_file)

        # 合并 contents + comments（如果评论存在）
        if comments_csv and comments_csv.exists():
            record_count = merge_contents_and_comments(contents_csv, comments_csv, output_file)
        else:
            shutil.copy2(contents_csv, output_file)
            # 统计行数（不含表头）
            import csv
            with open(contents_csv, "r", encoding="utf-8-sig", newline="") as f:
                record_count = sum(1 for _ in csv.DictReader(f))

        log(f"产物已保存: {output_file}", log_file)

        # 统计评论数
        comment_count = 0
        if comments_csv and comments_csv.exists():
            import csv
            with open(comments_csv, "r", encoding="utf-8-sig", newline="") as f:
                comment_count = sum(1 for _ in csv.DictReader(f))

        result = {
            "success": True,
            "record_count": record_count,
            "comment_count": comment_count,
            "output_file": str(output_file),
            "log_file": str(log_file),
        }
        print(json.dumps(result, ensure_ascii=False))

    except Exception as e:
        log(traceback.format_exc(), log_file)
        fail(f"运行 MediaCrawler 时出错: {e}", log_file)
    finally:
        restore_base_config()


if __name__ == "__main__":
    main()
