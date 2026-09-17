/**
 * 微信第三方平台授权账号存储（P3-04）。
 *
 * 每个商家公众号/小程序授权后落一条记录：
 * - authorizer_access_token / authorizer_refresh_token 均 AES-256-GCM 加密落库；
 * - status 区分 active / revoked：商家取消授权置 revoked，重新扫码授权恢复 active；
 * - 任何读取接口不得把 token 明文写进日志。
 */
import { decryptWithKey, encryptWithKey } from './ticket-store'

export type WechatAuthorizerStatus = 'active' | 'revoked'

export interface WechatAuthorizerAccount {
  authorizerAppId: string
  /** 以下两个 token 在存储层始终加密；接口返回的也是加密前的明文，仅供服务内部使用。 */
  authorizerAccessToken: string
  authorizerRefreshToken: string
  tokenExpiresAt: number
  tokenAcquiredAt: number
  nickname: string
  /** 账号类型：公众号(0)/小程序(1) 等，按微信返回原样保存。 */
  accountType: string
  status: WechatAuthorizerStatus
  authorizedAt: number
  updatedAt: number
}

export interface WechatAuthorizerStore {
  save(account: WechatAuthorizerAccount): Promise<void>
  load(authorizerAppId: string): Promise<WechatAuthorizerAccount | undefined>
  list(): Promise<WechatAuthorizerAccount[]>
  markRevoked(authorizerAppId: string, revokedAt: number): Promise<void>
}

/** 进程内实现：单测与单实例部署。 */
export class InMemoryWechatAuthorizerStore implements WechatAuthorizerStore {
  private accounts = new Map<string, WechatAuthorizerAccount>()

  async save(account: WechatAuthorizerAccount): Promise<void> {
    this.accounts.set(account.authorizerAppId, { ...account })
  }

  async load(authorizerAppId: string): Promise<WechatAuthorizerAccount | undefined> {
    const account = this.accounts.get(authorizerAppId)
    return account ? { ...account } : undefined
  }

  async list(): Promise<WechatAuthorizerAccount[]> {
    return [...this.accounts.values()].map((account) => ({ ...account }))
  }

  async markRevoked(authorizerAppId: string, revokedAt: number): Promise<void> {
    const account = this.accounts.get(authorizerAppId)
    if (account) this.accounts.set(authorizerAppId, { ...account, status: 'revoked', updatedAt: revokedAt })
  }
}

interface PostgresLikeClient {
  query<Row extends Record<string, unknown>>(statement: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>
}

interface AuthorizerRow extends Record<string, unknown> {
  authorizer_app_id: string
  encrypted_access_token: string
  encrypted_refresh_token: string
  token_expires_at: string
  token_acquired_at: string
  nickname: string
  account_type: string
  status: string
  authorized_at: string
  updated_at: string
}

export class PostgresWechatAuthorizerStore implements WechatAuthorizerStore {
  constructor(
    private readonly client: PostgresLikeClient,
    private readonly encryptionKey: Uint8Array,
  ) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_wechat_authorizer (
      authorizer_app_id TEXT PRIMARY KEY,
      encrypted_access_token TEXT NOT NULL,
      encrypted_refresh_token TEXT NOT NULL,
      token_expires_at BIGINT NOT NULL,
      token_acquired_at BIGINT NOT NULL,
      nickname TEXT NOT NULL DEFAULT '',
      account_type TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      authorized_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`)
  }

  async save(account: WechatAuthorizerAccount): Promise<void> {
    await this.client.query(
      `INSERT INTO proma_wechat_authorizer
         (authorizer_app_id, encrypted_access_token, encrypted_refresh_token, token_expires_at, token_acquired_at, nickname, account_type, status, authorized_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (authorizer_app_id) DO UPDATE SET
         encrypted_access_token = $2, encrypted_refresh_token = $3, token_expires_at = $4, token_acquired_at = $5,
         nickname = $6, account_type = $7, status = $8, updated_at = $10`,
      [
        account.authorizerAppId,
        encryptWithKey(account.authorizerAccessToken, this.encryptionKey),
        encryptWithKey(account.authorizerRefreshToken, this.encryptionKey),
        account.tokenExpiresAt,
        account.tokenAcquiredAt,
        account.nickname,
        account.accountType,
        account.status,
        account.authorizedAt,
        account.updatedAt,
      ],
    )
  }

  async load(authorizerAppId: string): Promise<WechatAuthorizerAccount | undefined> {
    const result = await this.client.query<AuthorizerRow>(
      'SELECT * FROM proma_wechat_authorizer WHERE authorizer_app_id = $1',
      [authorizerAppId],
    )
    const row = result.rows[0]
    if (!row) return undefined
    return this.decode(row)
  }

  async list(): Promise<WechatAuthorizerAccount[]> {
    const result = await this.client.query<AuthorizerRow>('SELECT * FROM proma_wechat_authorizer ORDER BY authorized_at DESC')
    return result.rows.map((row) => this.decode(row))
  }

  async markRevoked(authorizerAppId: string, revokedAt: number): Promise<void> {
    await this.client.query(
      `UPDATE proma_wechat_authorizer SET status = 'revoked', updated_at = $2 WHERE authorizer_app_id = $1`,
      [authorizerAppId, revokedAt],
    )
  }

  private decode(row: AuthorizerRow): WechatAuthorizerAccount {
    return {
      authorizerAppId: row.authorizer_app_id,
      authorizerAccessToken: decryptWithKey(row.encrypted_access_token, this.encryptionKey),
      authorizerRefreshToken: decryptWithKey(row.encrypted_refresh_token, this.encryptionKey),
      tokenExpiresAt: Number(row.token_expires_at),
      tokenAcquiredAt: Number(row.token_acquired_at),
      nickname: row.nickname,
      accountType: row.account_type,
      status: row.status === 'revoked' ? 'revoked' : 'active',
      authorizedAt: Number(row.authorized_at),
      updatedAt: Number(row.updated_at),
    }
  }
}
