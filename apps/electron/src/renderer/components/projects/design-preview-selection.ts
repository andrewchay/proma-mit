/** 在独立 origin 的静态预览中仅运行受控的选区桥，不运行成果自带脚本。 */
export function buildSelectableDesignPreview(html: string, token: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, iframe, frame, object, embed, base, meta[http-equiv]').forEach(node => node.remove())
  const policy = doc.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'nonce-${token}'; form-action 'none'; base-uri 'none'`
  doc.head.prepend(policy)
  const bridge = doc.createElement('script')
  bridge.setAttribute('nonce', token)
  bridge.textContent = `document.addEventListener('click', function(event) {
    event.preventDefault(); event.stopPropagation();
    const target = event.target;
    if (!(target instanceof Element) || target === document.body || target === document.documentElement) return;
    const text = (target.innerText || target.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 300);
    if (!text) return;
    window.parent.postMessage({ type: 'gravitas-design-selection', token: ${JSON.stringify(token)}, tag: target.tagName.toLowerCase(), text }, '*');
  }, true);`
  doc.body.append(bridge)
  return '<!DOCTYPE html>' + doc.documentElement.outerHTML
}

export interface DesignPreviewSelection { tag: string; text: string }

/** frame 的消息仅作为待用户确认的文字，不可触发宿主动作。 */
export function parseDesignPreviewSelection(event: MessageEvent, source: Window | null, token: string): DesignPreviewSelection | null {
  if (!source || event.source !== source || event.origin !== 'null' || !event.data || typeof event.data !== 'object') return null
  const data = event.data as Record<string, unknown>
  if (Object.keys(data).sort().join(',') !== 'tag,text,token,type' || data.type !== 'gravitas-design-selection' || data.token !== token || typeof data.tag !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(data.tag) || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 300) return null
  return { tag: data.tag, text: data.text }
}
