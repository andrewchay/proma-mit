/**
 * Mention 节点工具函数
 *
 * - resolveMentionSuggestionChar：节点自身携带的触发符才是持久化协议的权威来源。
 *   当旧草稿的 @/#/& 节点遇到仅注册 `/` suggestion 的编辑器时，
 *   不能回退成当前 suggestion 的字符（否则 @ 文件会被重写为 /skill）。
 */

export function resolveMentionSuggestionChar(nodeChar: unknown, fallbackChar?: string | null): string {
  if (typeof nodeChar === 'string' && nodeChar.length > 0) return nodeChar
  if (typeof fallbackChar === 'string' && fallbackChar.length > 0) return fallbackChar
  return '@'
}

// ===== 引用快捷输入防误触发 =====
//
// 用户在输入 / 粘贴 / 拖入内容时，可能碰到 URL、邮箱、文件路径、Markdown 标题、
// 十六进制色值、HTML 实体等合法文本，其中的 `@`、`#`、`&` 只是普通字符，不该
// 弹出引用菜单。这里提供纯函数判定，供各 Mention Suggestion 的 shouldShow / allow
// 钩子复用。规则定位为「不破坏正常快捷输入」（中文无空格正文后仍可直接输入）。

export interface CitationTriggerContext {
  /** 触发符所在段的完整文本（含触发符之后的内容），用于判断标题/实体等后置语义 */
  paragraphText: string
  /** 触发符在 paragraphText 中的下标 */
  triggerOffset: number
  /** 触发符，如 '@' / '#' / '&' */
  trigger: string
}

/**
 * 提取触发符所在「单词/段」(token) 的起始位置。以空白/换行/制表符为界。
 * 返回 token 在 paragraphText 中的起始下标；找不到则返回 -1。
 */
export function findTriggerTokenStart(paragraphText: string, triggerOffset: number): number {
  if (triggerOffset < 0 || triggerOffset > paragraphText.length) return -1
  let idx = triggerOffset - 1
  while (idx >= 0 && !/\s/.test(paragraphText[idx] ?? '')) idx -= 1
  return idx + 1
}

/**
 * 判断触发符是否落在某个带 scheme 的 URL 片段中（http/https/ssh/git/ftp/file…）。
 * 触发符必须出现在 `scheme://` 之后。
 */
export function isTriggerInsideSchemeUrl(paragraphText: string, triggerOffset: number): boolean {
  // 只看触发符左侧，找最后一个 `scheme://`，并确认触发符落在其后。
  const before = paragraphText.slice(0, triggerOffset)
  const schemeMatch = before.match(/(?:^|\s|\()([A-Za-z][A-Za-z\d+.-]*:\/\/)/)
  if (!schemeMatch || !schemeMatch[1]) return false
  const schemeAbsolute = before.lastIndexOf(schemeMatch[1]) + schemeMatch[1].length
  return triggerOffset > schemeAbsolute
}

/** 判断触发符是否落在邮箱地址中（`user@host`，触发符 @ 处于用户名与域名之间）。 */
export function isTriggerInsideEmail(paragraphText: string, triggerOffset: number): boolean {
  if (paragraphText[triggerOffset] !== '@') return false
  const start = findTriggerTokenStart(paragraphText, triggerOffset)
  if (start < 0) return false
  // 触发符左侧（Token 内）应是一段邮箱用户名字符，且不能带空格起点；右侧应是域名。
  const left = paragraphText.slice(start, triggerOffset)
  const leftOk = /^[A-Za-z0-9._%+-]+$/.test(left) && !left.includes(' ')
  const rightOk = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/.test(paragraphText.slice(triggerOffset + 1))
  return leftOk && rightOk
}

/** 判断（`#` 触发）是否落在 Markdown 标题 / issue 编号 / 十六进制色值后。 */
export function shouldSuppressHashTrigger({ paragraphText, triggerOffset, trigger }: CitationTriggerContext): boolean {
  if (trigger !== '#') return false
  const start = findTriggerTokenStart(paragraphText, triggerOffset)
  if (start < 0) return false
  const before = paragraphText.slice(0, start)
  // 行首（段开头）的 `#` 开头视为 Markdown 标题，不是引用。
  if (before.trim().length === 0 && /^#{1,6}(\s|$)/.test(paragraphText.slice(start))) return true
  const token = paragraphText.slice(start)
  // issue 编号 `#123` 或色值 `#a1b2c3`：紧跟触发符的是纯数字或 hex，不触发引用。
  if (/^\s*#\d+\b/.test(token)) return true
  if (/^\s*#[0-9a-fA-F]{3,8}\b/.test(token)) return true
  return false
}

/** 判断（`&` 触发）是否落在 `&&` 或 HTML 实体后。 */
export function shouldSuppressAmpTrigger({ paragraphText, triggerOffset, trigger }: CitationTriggerContext): boolean {
  if (trigger !== '&') return false
  // 逻辑与 `a && b`：触发符左侧或右侧紧跟 `&`，属于 `&&`，不触发会话引用。
  if (paragraphText[triggerOffset - 1] === '&' || paragraphText[triggerOffset + 1] === '&') return true
  // HTML 实体（&amp;、&lt;、&#39;、&nbsp; 等）：从触发符处向后组成 `&名字;`。
  const head = paragraphText.slice(triggerOffset)
  if (/^&([A-Za-z]+|#\d+|#x[0-9a-fA-F]+);/.test(head)) return true
  return false
}

/**
 * 判断当前触发符是否应该弹出引用菜单。
 * 返回 false 表示抑制（不弹出）。各 char 走各自规则，未识别语义默认放行。
 */
export function shouldAllowMentionTrigger(ctx: CitationTriggerContext): boolean {
  if (isTriggerInsideSchemeUrl(ctx.paragraphText, ctx.triggerOffset)) return false
  // 需要光标已在段内、且存在可读取的段文本。
  if (findTriggerTokenStart(ctx.paragraphText, ctx.triggerOffset) < 0) return false
  switch (ctx.trigger) {
    case '@':
      // 邮箱与 npm scope（@scope/pkg）不触发文件引用；普通 @file（行首/空格后）保留。
      if (isTriggerInsideEmail(ctx.paragraphText, ctx.triggerOffset)) return false
      // npm scope 形如 `@org/pkg`：触发符后紧跟 `名称/名称`。
      if (/^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/.test(ctx.paragraphText.slice(ctx.triggerOffset))) return false
      return true
    case '#':
      return !shouldSuppressHashTrigger(ctx)
    case '&':
      return !shouldSuppressAmpTrigger(ctx)
    default:
      return true
  }
}

/** 粘贴/拖入属于整段内容输入，不应把其中的普通文本解释成引用快捷输入。 */
export function shouldTriggerOnUiEvent(uiEvent: unknown): boolean {
  return uiEvent !== 'paste' && uiEvent !== 'drop'
}

// ===== 编辑器文档上下文提取 =====
//
// 上面的纯函数基于「整段文本 + 触发符下标」判定；这里把 ProseMirror 文档中的光标准置
// 换算成同样的参数（当前段落文本与触发符在段内的下标），供 Suggestion 的 allow 钩子调用。

import type { Node } from '@tiptap/pm/model'

/**
 * 从编辑器文档中定位触发符所在的「段落/块」文本与触发符下标。
 * 直接读取当前节点的 parent 文本（通常就是 paragraph），textOffset 即段内下标。
 * @param doc 编辑器文档
 * @param triggerPos 触发符在文档中的绝对位置（TipTap suggestion range.from）
 * @returns 段落文本与段内触发符下标；若无法定位则返回 null。
 */
export function resolveTriggerContext(
  doc: Node,
  triggerPos: number,
): { paragraphText: string; triggerOffset: number } | null {
  let $pos
  try {
    $pos = doc.resolve(triggerPos)
  } catch {
    return null
  }
  const parent = $pos.parent
  if (!parent || !parent.isTextblock) return null
  return { paragraphText: parent.textContent, triggerOffset: $pos.textOffset }
}
