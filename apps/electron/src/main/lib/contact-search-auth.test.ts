import { describe, expect, spyOn, test } from 'bun:test'
import { listDingtalkSubDeptIds, listDingtalkDeptUsers, resolveDingtalkUnionId, safeJson } from './contact-search-service'

describe('钉钉通讯录认证', () => {
  test('部门、成员与 unionid 请求都传递经过 URL 编码的应用 token', async () => {
    const requests: Array<{ url: URL; body: unknown }> = []
    using fetchSpy = spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input))
      requests.push({ url, body: JSON.parse(String(init?.body)) })
      if (url.pathname.endsWith('/department/listsub')) {
        return Response.json({ errcode: 0, result: [{ dept_id: 2 }] })
      }
      if (url.pathname.endsWith('/user/list')) {
        return Response.json({ errcode: 0, result: { list: [{ userid: 'user-1', name: '测试成员' }] } })
      }
      return Response.json({ errcode: 0, result: { unionid: 'union-1' } })
    }, { preconnect: () => {} }))
    const token = 'synthetic+/=&token'
    expect(await listDingtalkSubDeptIds(token, 1)).toEqual([2])
    expect(await listDingtalkDeptUsers(token, 2)).toEqual([{ userid: 'user-1', name: '测试成员' }])
    expect(await resolveDingtalkUnionId(token, 'user-1')).toBe('union-1')
    expect(requests).toHaveLength(3)
    for (const { url } of requests) {
      expect(url.origin).toBe('https://oapi.dingtalk.com')
      expect(url.searchParams.get('access_token')).toBe(token)
      expect([...url.searchParams.keys()]).toEqual(['access_token'])
    }
    expect(requests.map(({ body }) => body)).toEqual([
      { dept_id: 1 },
      { dept_id: 2, cursor: 0, size: 100 },
      { userid: 'user-1' },
    ])
  })

  test('非 JSON 错误不包含 URL 中的认证查询参数', async () => {
    const response = new Response('gateway error', { status: 502 })
    Object.defineProperty(response, 'url', {
      value: 'https://oapi.dingtalk.com/topapi/v2/user/get?access_token=synthetic-secret',
    })
    await expect(safeJson(response)).rejects.toThrow('HTTP 502, https://oapi.dingtalk.com/topapi/v2/user/get)')
    await expect(safeJson(new Response('invalid', { status: 502 }))).rejects.toThrow('接口返回非 JSON')
  })
})
