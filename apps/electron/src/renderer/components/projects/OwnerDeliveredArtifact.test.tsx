import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OwnerDeliveredArtifact, extractDeliveredHtml } from './OwnerDeliveredArtifact'

test('Given已交付HTML文本 When显示成果 Then正文直接可见且有原文和HTML下载、不运行HTML', () => {
  const html = '<!DOCTYPE html><html><body><script>window.unsafe=true</script></body></html>'
  const content = `这是源码\n\n\`\`\`html\n${html}\n\`\`\``
  expect(extractDeliveredHtml(content)).toBe(html)
  const markup = renderToStaticMarkup(createElement(OwnerDeliveredArtifact, { item: { stepKey: 'game', title: '游戏', content, artifactHash: 'a'.repeat(64), acceptanceCriteria: ['可玩'], ownerDecision: '接受', reviewerSummary: '静态审查' } }))
  expect(markup).toContain('下载 HTML')
  expect(markup).toContain('下载原文')
  expect(markup).toContain('成果正文')
  expect(markup).not.toContain('<script>window.unsafe')
  expect(markup.indexOf('成果正文')).toBeLessThan(markup.indexOf('<details'))
})

test('Given多份或不完整HTML代码块 When导出 Then不猜测文件、不从说明中拼接源码', () => {
  expect(extractDeliveredHtml('保存成2048.html即可打开')).toBeNull()
  expect(extractDeliveredHtml('```html\n<div>不完整</div>\n```')).toBeNull()
  expect(extractDeliveredHtml('```html\n<!DOCTYPE html><html></html>\n```\n```html\n<!DOCTYPE html><html></html>\n```')).toBeNull()
})
