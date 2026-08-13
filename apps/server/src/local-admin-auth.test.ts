import { describe, expect, it } from 'bun:test'
import { hashPassword, verifyPassword, parseAdminAccount } from './local-admin-auth'

describe('local-admin-auth', () => {
  it('hashPassword 产出带随机盐的 scrypt 哈希；verifyPassword 校验正确/错误密码', async () => {
    const hash = await hashPassword('s3cret-password')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('s3cret-password', hash)).toBe(true)
    expect(await verifyPassword('wrong-password', hash)).toBe(false)
  })

  it('hashPassword 可注入固定盐（可复现哈希）', async () => {
    const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    const h1 = await hashPassword('same-pw', salt)
    const h2 = await hashPassword('same-pw', salt)
    expect(h1).toBe(h2)
  })

  it('verifyPassword 对非 scrypt 格式返回 false', async () => {
    expect(await verifyPassword('x', 'not-a-valid-hash')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$1$1$1$oops')).toBe(false)
  })

  it('parseAdminAccount 解析 username:tenantId:password 格式', () => {
    const acct = parseAdminAccount('admin:tenant-a:s3cret')
    expect(acct).toEqual({ username: 'admin', tenantId: 'tenant-a', password: 's3cret' })
  })

  it('parseAdminAccount 对缺字段抛错', () => {
    expect(() => parseAdminAccount('admin:s3cret')).toThrow()
    expect(() => parseAdminAccount('admin:tenant-a')).toThrow()
    expect(() => parseAdminAccount('')).toThrow()
  })
})
