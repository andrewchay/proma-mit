import { afterEach, describe, test, expect } from 'bun:test'
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

// ===== fetchDoc 响应结构解析（mock fetch 防"字段层级读错"回归）=====

function makeFetcher(): FeishuDocFetcher {
  return new FeishuDocFetcher({ appId: 'app-test', appSecret: 'secret-test' })
}

/** 按 URL 路由返回飞书响应，模拟 fetch */
function mockFeishuFetch(router: (url: string, init?: RequestInit) => unknown): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const body = router(url, init)
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  }) as typeof fetch
}

afterEach(() => {
  ;(globalThis.fetch as unknown) = undefined
})

describe('FeishuDocFetcher.fetchDoc - docx 纯文本解析', () => {
  test('raw_content 内容在 data.content 内层 —— 必须取 data.content 而非顶层 content', async () => {
    // 回归用例：曾因读顶层 content 导致"飞书文档返回内容为空"
    mockFeishuFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return { code: 0, tenant_access_token: 'tok', expire: 7200 }
      }
      if (url.includes('/docx/v1/documents/')) {
        return { code: 0, data: { content: '会议纪要：本周目标达成，待办有三项。' } }
      }
      throw new Error('unexpected url: ' + url)
    })
    const res = await makeFetcher().fetchDoc('https://xxx.feishu.cn/docx/doccnABC123')
    expect(res.content).toBe('会议纪要：本周目标达成，待办有三项。')
    expect(res.title).toBe('doccnABC123')
  })

  test('docx 内容为空时抛可读错误', async () => {
    mockFeishuFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return { code: 0, tenant_access_token: 'tok', expire: 7200 }
      if (url.includes('/docx/v1/documents/')) return { code: 0, data: { content: '' } }
      throw new Error('unexpected url: ' + url)
    })
    await expect(makeFetcher().fetchDoc('https://xxx.feishu.cn/docx/doccnEMPTY')).rejects.toThrow('飞书文档返回内容为空')
  })
})

describe('FeishuDocFetcher.fetchDoc - sheets 表格解析', () => {
  test('读首个工作表前若干行拼接为内容', async () => {
    mockFeishuFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return { code: 0, tenant_access_token: 'tok', expire: 7200 }
      }
      if (url.includes('/sheets/v3/spreadsheets/')) {
        return { code: 0, data: { sheets: [{ sheet_id: 'giDkxx', title: '会议议程' }] } }
      }
      if (url.includes('/sheets/v2/spreadsheets/')) {
        return {
          code: 0,
          data: {
            valueRange: {
              values: [
                ['本周进展', '负责人'],
                ['完成需求评审', '张三'],
              ],
            },
          },
        }
      }
      throw new Error('unexpected url: ' + url)
    })
    const res = await makeFetcher().fetchDoc('https://team.feishu.cn/sheets/shtcnXYZ456')
    expect(res.title).toBe('会议议程')
    expect(res.content).toContain('完成需求评审')
    expect(res.content).toContain('张三')
  })
})

describe('FeishuDocFetcher.fetchDoc - wiki 知识库解析', () => {
  test('wiki 节点 obj_type=docx 时路由到 raw_content 并取 data.content', async () => {
    mockFeishuFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return { code: 0, tenant_access_token: 'tok', expire: 7200 }
      }
      if (url.includes('/wiki/v2/spaces/get_node')) {
        return {
          code: 0,
          data: { node: { node_token: 'wikcnQK789', obj_type: 'docx', obj_token: 'doccnWIKI01', title: '季度复盘' } },
        }
      }
      if (url.includes('/docx/v1/documents/')) {
        return { code: 0, data: { content: '知识库文档内容' } }
      }
      throw new Error('unexpected url: ' + url)
    })
    const res = await makeFetcher().fetchDoc('https://team.feishu.cn/wiki/wikcnQK789')
    expect(res.title).toBe('季度复盘')
    expect(res.content).toBe('知识库文档内容')
  })

  test('wiki 节点不支持的类型抛可读错误', async () => {
    mockFeishuFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return { code: 0, tenant_access_token: 'tok', expire: 7200 }
      if (url.includes('/wiki/v2/spaces/get_node')) return { code: 0, data: { node: { obj_type: 'mindnote', obj_token: 'x' } } }
      throw new Error('unexpected url: ' + url)
    })
    await expect(makeFetcher().fetchDoc('https://team.feishu.cn/wiki/wikcnQK777')).rejects.toThrow('暂不支持读取知识库节点类型: mindnote')
  })
})

describe('FeishuDocFetcher.fetchDoc - 权限/错误归一化', () => {
  test('权限错误码给出可读提示', async () => {
    mockFeishuFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return { code: 0, tenant_access_token: 'tok', expire: 7200 }
      if (url.includes('/docx/v1/documents/')) return { code: 99991672, msg: 'permission denied', data: {} }
      throw new Error('unexpected url: ' + url)
    })
    await expect(makeFetcher().fetchDoc('https://xxx.feishu.cn/docx/doccnPERM')).rejects.toThrow('权限不足')
  })
})
