/**
 * WebFetch 工具实现（Agent Runtime）
 *
 * 抓取指定 URL 的网页并提取可读文本，供模型理解页面内容。
 * 只支持 http/https，输出大小受限。
 *
 * WebFetch 与 WebSearch 同为只读网页工具（SAFE_TOOLS，自动放行）。
 * 与 Web Bridge 的区别：WebFetch 不启动受管浏览器、不加载登录态、无有状态操作。
 */

import type { ToolResult } from '@proma/core'
import type { ToolContext } from '../types.ts'
import { truncateOutput } from './tool-utils.ts'
import { getFetchFn } from '../../proxy-fetch'
import { getEffectiveProxyUrl } from '../../proxy-settings-service'

export const WEB_FETCH_TOOL_NAME = 'WebFetch'

/** 默认抓取超时 */
const FETCH_TIMEOUT_MS = 15_000

/** 提取正文的最大字节数（截断前） */
const MAX_BODY_BYTES = 2_000_000

/** 返回文本上限（由 truncateOutput 兜底，这里再显式控制一次） */
const MAX_TEXT_CHARS = 12_000

export interface WebFetchToolInput {
  url: string
}

export function createWebFetchToolDefinition() {
  return {
    name: WEB_FETCH_TOOL_NAME,
    description:
      '抓取指定 URL 的网页内容并提取可读文本。当用户给出具体网址、或需要查看某个页面/文章的完整内容时使用。只读取页面文本，不会登录或执行页面交互。',
    parameters: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: '要抓取的完整 URL（http/https）',
        },
      },
      required: ['url'],
    },
  }
}

export async function executeWebFetchTool(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
  const params = input as WebFetchToolInput
  const url = params.url?.trim()

  if (!url) {
    return { toolCallId: '', content: '抓取参数缺失: url', isError: true }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { toolCallId: '', content: `无效的 URL: ${url}`, isError: true }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { toolCallId: '', content: `不支持的协议: ${parsed.protocol}（仅允许 http/https）`, isError: true }
  }

  try {
    // 网络请求统一跟随 Proma 代理设置
    const proxyUrl = await getEffectiveProxyUrl()
    const fetchFn = getFetchFn(proxyUrl)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetchFn(parsed.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 PromaAgent/1.0',
          'Accept': 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      return { toolCallId: '', content: `抓取失败 (${response.status} ${response.statusText})`, isError: true }
    }

    const contentType = response.headers.get('content-type') ?? ''
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_BODY_BYTES) {
      return { toolCallId: '', content: `页面过大（${buffer.byteLength} bytes），已放弃抓取`, isError: true }
    }

    const raw = new TextDecoder('utf-8').decode(buffer)

    // 非 HTML 内容（JSON、纯文本等）直接截断返回
    if (!contentType.includes('text/html')) {
      const text = raw.trim() || '(空内容)'
      return { toolCallId: '', content: `**URL：** ${parsed.toString()}\n\n${truncateOutput(text, MAX_TEXT_CHARS)}` }
    }

    const text = htmlToReadableText(raw).trim()
    if (!text) {
      return { toolCallId: '', content: '页面没有可提取的文本内容', isError: true }
    }
    return { toolCallId: '', content: `**URL：** ${parsed.toString()}\n\n${truncateOutput(text, MAX_TEXT_CHARS)}` }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[Agent WebFetch] 执行失败:', error)
    return { toolCallId: '', content: `抓取失败: ${msg}`, isError: true }
  }
}

/**
 * 简易 HTML → 可读文本转换：
 * 去掉 script/style/noscript/svg 内容与 HTML 标签，保留标题、段落与链接文本。
 */
function htmlToReadableText(html: string): string {
  let out = html
  // 去除脚本与样式块
  out = out.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  out = out.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  out = out.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  out = out.replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
  // 常见块级标签替换为换行
  out = out.replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|tr|section|article|header|footer|blockquote)>/gi, '\n')
  out = out.replace(/<br\s*\/?>/gi, '\n')
  // 去掉剩余标签
  out = out.replace(/<[^>]+>/g, ' ')
  // 解码常见实体
  out = out.replace(/&nbsp;/g, ' ')
  out = out.replace(/&amp;/g, '&')
  out = out.replace(/&lt;/g, '<')
  out = out.replace(/&gt;/g, '>')
  out = out.replace(/&quot;/g, '"')
  out = out.replace(/&#39;/g, "'")
  // 压缩空白
  out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/^\s*\n/gm, '')
  return out.trim()
}
