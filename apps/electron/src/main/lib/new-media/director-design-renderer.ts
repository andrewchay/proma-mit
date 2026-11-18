import { BrowserWindow } from 'electron'

export const DIRECTOR_DESIGN_WIDTH = 1080
export const DIRECTOR_DESIGN_HEIGHT = 1440

/** SVG 作为图片加载；禁止动态内容和外部资源，避免设计内容访问本地或网络。 */
export function validateDirectorSvg(svg: string): void {
  if (typeof svg !== 'string' || Buffer.byteLength(svg, 'utf8') > 500_000 || !/^\s*<svg\b/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) throw new Error('设计必须是完整的 SVG，且不超过 500 KB')
  if (!/\bviewBox\s*=\s*["'][^"']+["']/i.test(svg)) throw new Error('SVG 必须设置 viewBox')
  // XML 注释不会执行或加载资源；保留对其他声明和动态内容的限制。
  const withoutComments = svg.replace(/<!--[\s\S]*?-->/g, '')
  if (/<\s*(?:script|foreignObject|image|iframe|object|embed|style)\b|<!|<\?|\son[a-z]+\s*=|(?:href|xlink:href)\s*=|url\s*\(/i.test(withoutComments)) throw new Error('SVG 包含不支持的动态内容或外部资源')
}

/** 使用隔离的 Chromium 图片渲染，不执行设计中的脚本或访问网络。 */
export async function renderDirectorSvg(svg: string, dimensions: { width: number; height: number } = { width: DIRECTOR_DESIGN_WIDTH, height: DIRECTOR_DESIGN_HEIGHT }): Promise<Buffer> {
  validateDirectorSvg(svg)
  const imageUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0;width:100%;height:100%;background:#fff}img{display:block;width:100%;height:100%;object-fit:contain}</style><img src="${imageUrl}">`
  const win = new BrowserWindow({
    width: dimensions.width, height: dimensions.height, show: false, frame: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, javascript: true, webSecurity: true, offscreen: true },
  })
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
    const loaded = await win.webContents.executeJavaScript('Boolean(document.images[0] && document.images[0].complete && document.images[0].naturalWidth > 0 && document.images[0].naturalHeight > 0)') as boolean
    if (!loaded) throw new Error('SVG 无法解析或渲染，请检查设计源文件')
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: dimensions.width, height: dimensions.height })
    if (image.isEmpty()) throw new Error('设计图片渲染为空')
    return image.resize({ width: dimensions.width, height: dimensions.height }).toPNG()
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
