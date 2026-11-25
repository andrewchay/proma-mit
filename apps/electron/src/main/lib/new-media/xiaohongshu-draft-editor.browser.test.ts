import { existsSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { chromium } from 'playwright-core'
import { runXiaohongshuDraftEditor, XHS_CREATOR_ORIGIN, XHS_IMAGE_EDITOR_PATH } from './xiaohongshu-draft-editor'

const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('只填充官方图文的空白编辑器，保留已输入的内容且不提交', async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(2500)
    await page.route('**/*', route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<form onsubmit="event.preventDefault(); document.body.dataset.submitted = 'yes'">
        <input placeholder="填写标题会有更多赞哦" maxlength="20">
        <div role="textbox" contenteditable="true"></div>
        <button>发布</button>
      </form>`,
    }))
    const copy = { title: '英语学习小练习', body: '第一段\n\n第二段\n\n#英语' }
    const run = (action: 'fill' | 'verify', value = copy) => page.evaluate(
      `(${runXiaohongshuDraftEditor.toString()})(...${JSON.stringify([XHS_CREATOR_ORIGIN, XHS_IMAGE_EDITOR_PATH, value, action])})`,
    )
    const fill = (value = copy) => run('fill', value)
    const editor = `${XHS_CREATOR_ORIGIN}${XHS_IMAGE_EDITOR_PATH}?target=image`
    await page.goto('https://example.test/publish/publish?target=image')
    expect(await fill()).toBe('editor_unavailable')
    await page.goto(editor + '&useDraft=true')
    expect(await fill()).toBe('editor_unavailable')
    expect(await run('verify')).toBe('mismatch')
    await page.getByPlaceholder('填写标题会有更多赞哦').fill(copy.title)
    await page.locator('[contenteditable]').fill(copy.body)
    expect(await run('verify')).toBe('verified')
    expect(await run('verify', { ...copy, title: '另一篇内容' })).toBe('mismatch')
    expect(await page.getByPlaceholder('填写标题会有更多赞哦').inputValue()).toBe(copy.title)
    await page.goto(editor)
    await page.getByPlaceholder('填写标题会有更多赞哦').fill('用户已有标题')
    expect(await fill()).toBe('occupied')
    expect(await page.locator('[contenteditable]').innerText()).toBe('')
    await page.getByPlaceholder('填写标题会有更多赞哦').fill('')
    expect(await fill({ ...copy, body: '文'.repeat(1001) })).toBe('check_manually')
    expect(await fill()).toBe('filled')
    expect(await run('verify')).toBe('editor_unavailable')
    expect(await page.getByPlaceholder('填写标题会有更多赞哦').inputValue()).toBe(copy.title)
    expect((await page.locator('[contenteditable]').innerText()).replace(/\n{2,}/g, '\n\n')).toBe(copy.body)
    expect(await fill()).toBe('filled')
    expect(await page.locator('body').getAttribute('data-submitted')).toBeNull()
    await page.reload()
    await page.locator('input').evaluate(element => {
      element.addEventListener('input', () => setTimeout(() => { (element as HTMLInputElement).value = '' }, 10))
    })
    expect(await fill()).toBe('check_manually')
  } finally {
    await browser.close()
  }
})
