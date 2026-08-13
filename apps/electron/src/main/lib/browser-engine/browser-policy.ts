/**
 * Browser Engine URL 规范化与校验（无 Electron 依赖，便于单测）。
 *
 * 目标：地址栏输入可能是裸域名、带端口、协议相对等，需要规范化：
 *  - 裸域名、带端口本地服务默认补 https，本机 loopback 补 http；
 *  - 只接受合法可解析 URL；
 *  - 协议相对（//x）视为 https。
 */

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host.replace(/^\[|\]$/g, '') === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return Number(match?.[1]) === 127
}

export function normalizeBrowserUrl(input: string): string {
  const value = input.trim()
  if (!value) throw new Error('浏览器地址不能为空。')

  // 协议相对 URL（//example.com）
  if (value.startsWith('//')) return `https:${value}`

  // `localhost:3000` / `example.com:8080` 是无协议的常见地址栏输入，不应被误判为 scheme。
  if (/^[^/?#:\s]+:\d+(?:[/?#]|$)/.test(value)) {
    const candidate = new URL(`http://${value}`)
    return isLoopbackHostname(candidate.hostname) ? `http://${value}` : `https://${value}`
  }

  // 已有显式 scheme（http/https/file 等），不做改写。
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) return value

  // 裸 localhost / app.localhost（无端口也按 http）。
  try {
    const candidate = new URL(`http://${value}`)
    if (isLoopbackHostname(candidate.hostname)) return `http://${value}`
  } catch {
    // 交由后续 URL 校验输出统一错误
  }

  return `https://${value}`
}

/** 拒绝空值或无法被 URL 标准解析的输入；不做网络/协议白名单限制。 */
export function assertSafeBrowserUrl(input: string): string {
  const normalized = normalizeBrowserUrl(input)
  try {
    return new URL(normalized).toString()
  } catch {
    throw new Error('浏览器地址无效。')
  }
}

/** 异步形式的导航校验入口，兼容之前 Promise 调用面。 */
export async function assertSafeBrowserDestination(input: string): Promise<string> {
  return assertSafeBrowserUrl(input)
}
