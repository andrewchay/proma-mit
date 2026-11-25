import { BrowserWindow } from 'electron'
import { getXiaohongshuBrowserDraft, recordXiaohongshuDraftReadback } from './xiaohongshu-handoff'
import { runXiaohongshuDraftEditor, XHS_CREATOR_ORIGIN, XHS_IMAGE_EDITOR_PATH } from './xiaohongshu-draft-editor'

const EDITOR_URL = `${XHS_CREATOR_ORIGIN}${XHS_IMAGE_EDITOR_PATH}?target=image`
let active: { handoffId: string; window: BrowserWindow } | undefined

function assertActive(handoffId: string): BrowserWindow {
  if (active?.handoffId !== handoffId || active.window.isDestroyed()) throw new Error('请先打开这篇草稿的小红书创作页。')
  return active.window
}

export async function openXiaohongshuDraftBrowser(handoffId: string): Promise<void> {
  await getXiaohongshuBrowserDraft(handoffId)
  if (active && !active.window.isDestroyed()) {
    if (active.handoffId !== handoffId) throw new Error('请先完成当前小红书草稿并关闭创作窗口，再打开另一篇。')
    active.window.show()
    return
  }
  const window = new BrowserWindow({
    width: 1200,
    height: 820,
    title: '小红书官方创作平台',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:gravitas-xiaohongshu-creator',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  active = { handoffId, window }
  window.on('closed', () => { if (active?.window === window) active = undefined })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const allowOfficialOrigin = (event: Electron.Event, url: string) => {
    if (URL.parse(url)?.origin !== XHS_CREATOR_ORIGIN) event.preventDefault()
  }
  window.webContents.on('will-navigate', allowOfficialOrigin)
  window.webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) allowOfficialOrigin(event, url)
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)
  try {
    await window.loadURL(EDITOR_URL)
  } catch {
    if (!window.isDestroyed()) window.close()
    throw new Error('无法打开小红书创作平台，请检查网络后重试。')
  }
}

export async function operateXiaohongshuDraftBrowser(handoffId: string, action: 'fill' | 'verify'): Promise<void> {
  const window = assertActive(handoffId)
  const { title, body } = await getXiaohongshuBrowserDraft(handoffId)
  if (window !== assertActive(handoffId)) throw new Error('创作窗口已切换，请重新打开草稿。')
  const url = URL.parse(window.webContents.getURL())
  const matchesEditor = url?.origin === XHS_CREATOR_ORIGIN && url.pathname === XHS_IMAGE_EDITOR_PATH && url.searchParams.get('target') === 'image'
  const args = JSON.stringify([XHS_CREATOR_ORIGIN, XHS_IMAGE_EDITOR_PATH, { title, body }, action])
  const result: unknown = matchesEditor
    ? await window.webContents.executeJavaScriptInIsolatedWorld(1001, [
      { code: `(${runXiaohongshuDraftEditor.toString()})(...${args})` },
    ], true)
    : 'editor_unavailable'
  if (window !== assertActive(handoffId)) throw new Error('创作窗口已切换，请重新打开草稿。')
  window.show()
  if (action === 'verify') {
    if (result === 'verified' && window.webContents.getURL() === url?.href) {
      await recordXiaohongshuDraftReadback(handoffId)
      return
    }
    if (result === 'mismatch') throw new Error('重开的草稿文案与这篇交接不一致，请核对打开的是哪篇草稿。')
    throw new Error('请先在小红书暂存，然后从官方创作页重新打开该草稿。')
  }
  if (result === 'filled') return
  if (result === 'occupied') throw new Error('编辑器已有内容。请先暂存当前内容，再新建空白图文。')
  if (result === 'editor_unavailable') throw new Error('未找到图文编辑字段。请先上传图片进入编辑器，或复制文案后手动填写。')
  throw new Error('无法确认文案已完整填入，请在小红书检查编辑器中的内容。')
}
