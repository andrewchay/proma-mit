import { describe, expect, test } from 'bun:test'
import { buildFeishuFindByDepartmentUrl } from './contact-search-service'

describe('飞书 find_by_department URL 构造', () => {
  test('路径必须是复数 users（单数 user/ 会被飞书网关返回 HTTP 404）', () => {
    const url = buildFeishuFindByDepartmentUrl({ idType: 'department_id', value: '0' })
    expect(url).toContain('/open-apis/contact/v3/users/find_by_department?')
    expect(url).not.toContain('/contact/v3/user/')
    expect(url).toContain('department_id_type=department_id')
    expect(url).toContain('department_id=0')
    expect(url).toContain('page_size=50')
  })

  test('open_department_id 类型与 page_token 追加正确', () => {
    const url = buildFeishuFindByDepartmentUrl({
      idType: 'open_department_id',
      value: 'od-8f2a1b3c',
      pageSize: 20,
      pageToken: 'tok-abc',
    })
    expect(url).toContain('department_id_type=open_department_id')
    expect(url).toContain('department_id=od-8f2a1b3c')
    expect(url).toContain('page_size=20')
    expect(url).toContain('page_token=tok-abc')
  })
})
