/**
 * Brief 回执回调服务器 — Brief Callback Server
 *
 * 轻量 HTTP 服务（内嵌 Electron 主进程）：
 * - GET  /brief/{receiptId}  → H5 回执表单页
 * - POST /brief/{receiptId}  → 提交回执，写入 brief_receipts
 *
 * 通过内网穿透（cloudflared quick tunnel / frp）暴露公网 URL，
 * 供钉钉消息中的「填写回执」链接打开。
 *
 * 默认端口 8765，可通过设置覆盖。
 */

import { createServer, type Server } from 'node:http'
import { recordBriefResponse } from './brief-service'

let server: Server | null = null
let currentPort = 0

/** 启动回执服务（幂等：已启动则返回现有端口） */
export function startBriefCallbackServer(port = 8765): Promise<number> {
  if (server) return Promise.resolve(currentPort)
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`)
      const match = url.pathname.match(/^\/brief\/([A-Za-z0-9-]+)\/?$/)

      if (req.method === 'GET' && match) {
        handleFormPage(res, match[1]!)
        return
      }
      if (req.method === 'POST' && match) {
        handleFormSubmit(req, res, match[1]!)
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
    })

    server.on('error', (error) => {
      server = null
      reject(error)
    })

    server.listen(port, '0.0.0.0', () => {
      const address = server?.address()
      currentPort = typeof address === 'object' && address ? address.port : port
      console.log(`[BriefCallback] 回执服务已启动: http://localhost:${currentPort}`)
      resolve(currentPort)
    })
  })
}

/** 停止回执服务 */
export function stopBriefCallbackServer(): void {
  if (server) {
    server.close()
    server = null
    currentPort = 0
  }
}

/** 获取回执服务的公网基础地址（内网穿透 URL），未配置时返回本地地址 */
export function getBriefCallbackBaseUrl(): string | undefined {
  try {
    const { getSettings } = require('./settings-service') as typeof import('./settings-service')
    const settings = getSettings()
    const tunnel = settings.briefCallback?.tunnelUrl
    if (tunnel) return tunnel
  } catch {
    // 设置不可用时退回本地地址
  }
  return currentPort ? `http://localhost:${currentPort}` : undefined
}

function handleFormPage(res: import('node:http').ServerResponse, receiptId: string): void {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>任务回执</title>
<style>
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f6f8; margin: 0; padding: 24px; }
  .card { max-width: 480px; margin: 40px auto; background: #fff; border-radius: 12px; padding: 28px; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  h2 { margin-top: 0; color: #1f2329; }
  label { display: block; margin: 16px 0 8px; font-weight: 600; color: #333; }
  textarea { width: 100%; min-height: 120px; border: 1px solid #d0d3d9; border-radius: 8px; padding: 12px; box-sizing: border-box; font-size: 14px; }
  button { width: 100%; margin-top: 20px; padding: 12px; background: #0066ff; color: #fff; border: none; border-radius: 8px; font-size: 15px; cursor: pointer; }
  button:hover { background: #0052cc; }
  .hint { color: #888; font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
  <div class="card">
    <h2>任务回执</h2>
    <form method="POST" action="/brief/${receiptId}">
      <label for="content">回执内容</label>
      <textarea id="content" name="content" placeholder="请简要说明你对本任务的理解、计划或风险（必填）"></textarea>
      <button type="submit">提交回执</button>
      <div class="hint">提交后，项目经理将在桌面端看到你的回执。</div>
    </form>
  </div>
</body>
</html>`
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

function handleFormSubmit(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  receiptId: string
): void {
  let body = ''
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString('utf-8')
  })
  req.on('end', () => {
    const params = new URLSearchParams(body)
    const content = (params.get('content') ?? '').trim()
    if (!content) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<h3>回执内容不能为空</h3><a href="javascript:history.back()">返回重填</a>')
      return
    }
    const receipt = recordBriefResponse(receiptId, content)
    if (!receipt) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<h3>回执不存在或已失效</h3>')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>提交成功</title></head>
<body style="font-family:sans-serif;padding:40px;text-align:center">
<h2>✅ 回执已提交</h2><p>感谢填写，项目经理已收到你的回执。</p></body></html>`)
  })
}
