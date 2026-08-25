# MediaCrawler 环境准备

本 Skill 依赖 MediaCrawler（Git submodule）和 uv 包管理器。

## 1. 初始化子模块

首次克隆 Gravitas 仓库后，必须初始化子模块：

```bash
cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project
git submodule update --init --recursive
```

如果已经克隆但没有初始化，也可以：

```bash
cd apps/electron/default-skills/ma-media-crawler
git submodule update --init --recursive MediaCrawler
```

## 2. 安装 uv

本 Skill 使用 `uv run` 运行 MediaCrawler，无需手动创建虚拟环境。

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

或参考官方文档：https://docs.astral.sh/uv/getting-started/installation/

## 3. 启动 Chrome CDP

macOS：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-dev-profile
```

Windows：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir=C:\temp\chrome-dev-profile
```

Linux：

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-dev-profile
```

## 4. 登录小红书

在启动的 Chrome 中访问 https://www.xiaohongshu.com 并登录。

## 5. 验证 CDP 是否可用

```bash
curl http://127.0.0.1:9222/json/version
```

如果能看到 JSON 响应，说明 CDP 已就绪。

## 6. 运行示例

```bash
cd apps/electron/default-skills/ma-media-crawler
python3 scripts/media_crawler_runner.py --config examples/xhs-detail-config.json
```

## 常见问题

### 提示 `MediaCrawler 子模块不存在`

检查目录是否为空：

```bash
ls apps/electron/default-skills/ma-media-crawler/MediaCrawler/main.py
```

如果为空，运行 `git submodule update --init --recursive`。

### uv 找不到

确保 `~/.local/bin` 在 PATH 中：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Chrome CDP 连接失败

- 检查端口是否被占用：`lsof -i :9222` / `netstat -ano | findstr 9222`
- 检查是否使用了正确的 Chrome 用户数据目录
- 检查防火墙/安全软件是否拦截本地连接

### 小红书登录态失效

- 在 CDP Chrome 中重新登录
- 避免在多个浏览器实例间频繁切换账号
- 检查是否触发风控验证
