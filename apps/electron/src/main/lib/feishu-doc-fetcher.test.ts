import { describe, test, expect } from 'bun:test'
import { FeishuDocFetcher } from './feishu-doc-fetcher'

describe('FeishuDocFetcher.parseFeishuUrl', () => {
  test('解析 docx 新版文档链接', () => {
    const res = FeishuDocFetcher.parseFeishuUrl('https://xxx.feishu.cn/docx/doccnABC123')
    expect(res).toEqual({ kind: 'docx', id: 'doccnABC123' })
  })

  test('解析 sheets 表格链接', () => {
    const res = FeishuDocFetcher.parseFeishuUrl('https://team.feishu.cn/sheets/shtcnXYZ456')
    expect(res).toEqual({ kind: 'sheets', id: 'shtcnXYZ456' })
  })

  test('解析 wiki 知识库链接', () => {
    const res = FeishuDocFetcher.parseFeishuUrl('https://team.feishu.cn/wiki/wikcnQK789')
    expect(res).toEqual({ kind: 'wiki', id: 'wikcnQK789' })
  })

  test('忽略查询参数', () => {
    const res = FeishuDocFetcher.parseFeishuUrl(
      'https://xxx.feishu.cn/docx/doccnABC123?from=page'
    )
    expect(res).toEqual({ kind: 'docx', id: 'doccnABC123' })
  })

  test('国际版域名 larksuite.com 也能识别', () => {
    const res = FeishuDocFetcher.parseFeishuUrl('https://xxx.larksuite.com/wiki/wikcnQK789')
    expect(res).toEqual({ kind: 'wiki', id: 'wikcnQK789' })
  })

  test('非飞书链接返回 null', () => {
    expect(FeishuDocFetcher.parseFeishuUrl('https://alidocs.dingtalk.com/i/nodes/abc')).toBeNull()
    expect(FeishuDocFetcher.parseFeishuUrl('https://example.com/foo/bar')).toBeNull()
    expect(FeishuDocFetcher.parseFeishuUrl('')).toBeNull()
  })

  test('仅资源 id 也按正常路径返回（兼容粘贴裸 id 场景）', () => {
    const res = FeishuDocFetcher.parseFeishuUrl('https://xxx.feishu.cn/docx/')
    expect(res).toBeNull()
  })
})
