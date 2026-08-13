import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (password: string | Buffer, salt: Buffer, keylen: number) => Promise<Buffer>

const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEYLEN = 32

/**
 * 本地管理员密码（scrypt 哈希）。
 * 存储格式：`scrypt$N$r$p$saltB64$hashB64`。随机盐保证同密码不同哈希。
 */
export async function hashPassword(password: string, salt: Uint8Array = randomBytes(16)): Promise<string> {
  const derived = await scrypt(password, Buffer.from(salt), KEYLEN)
  const parts = [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    Buffer.from(salt).toString('base64'),
    derived.toString('base64'),
  ]
  return parts.join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const saltB64 = parts[4]!
  const hashB64 = parts[5]!
  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(hashB64, 'base64')
  const derived = await scrypt(password, salt, expected.length)
  return timingSafeEqual(derived, expected)
}

export interface AdminAccount {
  username: string
  tenantId: string
  password: string
}

/** 解析 `PROMA_WEB_ADMIN=username:tenantId:password`（私有部署 bootstrap 管理员） */
export function parseAdminAccount(raw: string): AdminAccount {
  const parts = (raw ?? '').split(':')
  if (parts.length !== 3) throw new Error('PROMA_WEB_ADMIN 必须是 username:tenantId:password 格式')
  const [username, tenantId, password] = parts
  if (!username || !tenantId || !password) throw new Error('PROMA_WEB_ADMIN 的 username/tenantId/password 不能为空')
  return { username, tenantId, password }
}
