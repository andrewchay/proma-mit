export const XHS_CREATOR_ORIGIN = 'https://creator.xiaohongshu.com'
export const XHS_IMAGE_EDITOR_PATH = '/publish/publish'

export interface XiaohongshuEditorCopy {
  title: string
  body: string
}

/** 在隔离世界运行；核对已重开的草稿时只读取字段。 */
export async function runXiaohongshuDraftEditor(
  origin: string,
  path: string,
  copy: XiaohongshuEditorCopy,
  action: 'fill' | 'verify',
): Promise<'filled' | 'verified' | 'mismatch' | 'occupied' | 'editor_unavailable' | 'check_manually'> {
  const initialUrl = location.href
  const url = new URL(initialUrl)
  if (url.origin !== origin || url.pathname !== path || url.searchParams.get('target') !== 'image') return 'editor_unavailable'
  const reopenedDraft = url.searchParams.get('useDraft') === 'true'
  if (action === 'verify' ? !reopenedDraft : url.searchParams.has('useDraft')) return 'editor_unavailable'

  const titles = document.querySelectorAll<HTMLInputElement>('input[placeholder="填写标题会有更多赞哦"]')
  const bodies = document.querySelectorAll<HTMLElement>('[role="textbox"][contenteditable="true"]')
  const title = titles[0]
  const body = bodies[0]
  if (titles.length !== 1 || bodies.length !== 1 || !title || !body || title.disabled || title.readOnly ||
    title.getClientRects().length === 0 || body.getClientRects().length === 0) return 'editor_unavailable'

  const readBody = () => (body.innerText || '').trim()
  // Chromium 和富文本编辑器对空段落可能计算出不同数量的换行。
  const normalizeParagraphs = (text: string) => text.replace(/\n{2,}/g, '\n\n')
  const bodyMatches = () => normalizeParagraphs(readBody()) === normalizeParagraphs(copy.body)
  if (action === 'verify') return title.value === copy.title && bodyMatches() ? 'verified' : 'mismatch'
  if (title.value === copy.title && bodyMatches()) return 'filled'
  if (title.value.trim() || readBody()) return 'occupied'
  if ((title.maxLength >= 0 && copy.title.length > title.maxLength) || copy.body.length > 1000) return 'check_manually'
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setValue) return 'check_manually'

  body.focus()
  if (document.activeElement !== body || !document.execCommand('insertText', false, copy.body)) return 'check_manually'
  if (location.href !== initialUrl || !bodyMatches() || !title.isConnected || title.value.trim()) return 'check_manually'
  setValue.call(title, copy.title)
  title.dispatchEvent(new Event('input', { bubbles: true }))
  // 等网页表单处理输入及重渲染，再核对两个字段。
  await new Promise(resolve => setTimeout(resolve, 100))
  if (location.href !== initialUrl || !title.isConnected || !body.isConnected) return 'check_manually'
  return title.value === copy.title && bodyMatches() ? 'filled' : 'check_manually'
}
