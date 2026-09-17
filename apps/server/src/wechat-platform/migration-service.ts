/**
 * wechat-direct → 开放平台授权迁移（P3-08）。
 *
 * 定位：迁移绑定服务。Electron 侧的 wechat-direct 账号（本地 appid + secret）迁移到
 * 第三方平台授权后，本服务维护两者的绑定关系与状态机。真正的「向导 UI」在 Electron
 * 实现，本模块是它调用的服务端规则层。
 *
 * 数据绑定规则（硬性不变量）：
 * 1. 历史草稿/指标保留：绑定只是追加元数据，绝不移动或删除 Electron 侧任何历史数据——
 *    草稿与指标继续以 directAccountId 为键留存，查询侧按绑定关系归并展示；
 * 2. 不可静默换绑：一个 authorizerAppId 同时只允许一条 active/completed 绑定；
 *    同一 directAccountId 重复迁移必须显式给出 changeReason，旧记录标记 superseded 而不是删除；
 * 3. 旧 Secret 可安全删除：仅当迁移 completed 且平台侧 token 实际可取（canDeleteLegacySecret）
 *    才返回 true；删除动作本身由 Electron 侧凭此信号执行，服务端不触达本地 secret。
 */
import type { WechatAuthorizerStore } from './authorizer-store'
import { WechatAuthorizerUnavailableError } from './authorization-service'
import type { WechatAuthorizationService } from './authorization-service'

export type WechatMigrationStatus = 'pending' | 'completed' | 'rolled_back' | 'superseded'

export interface WechatDirectMigrationRecord {
  migrationId: string
  tenantId: string
  /** Electron 侧 direct 账号标识（本地 new-media 账号 id）。 */
  directAccountId: string
  /** 迁移目标：开放平台授权账号。 */
  authorizerAppId: string
  status: WechatMigrationStatus
  /** 迁移原因/说明（重复迁移时必填，审计用）。 */
  changeReason: string
  createdAt: number
  confirmedAt?: number
  completedAt?: number
}

export interface WechatDirectMigrationStore {
  save(record: WechatDirectMigrationRecord): Promise<void>
  load(migrationId: string): Promise<WechatDirectMigrationRecord | undefined>
  /** 按 authorizerAppId 查 active/completed/superseded 全量历史（换绑判定用）。 */
  listByAuthorizer(authorizerAppId: string): Promise<WechatDirectMigrationRecord[]>
  listByDirectAccount(directAccountId: string): Promise<WechatDirectMigrationRecord[]>
  listByTenant(tenantId: string): Promise<WechatDirectMigrationRecord[]>
}

/** 进程内实现。 */
export class InMemoryWechatDirectMigrationStore implements WechatDirectMigrationStore {
  private records = new Map<string, WechatDirectMigrationRecord>()

  async save(record: WechatDirectMigrationRecord): Promise<void> {
    this.records.set(record.migrationId, { ...record })
  }

  async load(migrationId: string): Promise<WechatDirectMigrationRecord | undefined> {
    const record = this.records.get(migrationId)
    return record ? { ...record } : undefined
  }

  async listByAuthorizer(authorizerAppId: string): Promise<WechatDirectMigrationRecord[]> {
    return [...this.records.values()].filter((record) => record.authorizerAppId === authorizerAppId).map((record) => ({ ...record }))
  }

  async listByDirectAccount(directAccountId: string): Promise<WechatDirectMigrationRecord[]> {
    return [...this.records.values()].filter((record) => record.directAccountId === directAccountId).map((record) => ({ ...record }))
  }

  async listByTenant(tenantId: string): Promise<WechatDirectMigrationRecord[]> {
    return [...this.records.values()].filter((record) => record.tenantId === tenantId).map((record) => ({ ...record }))
  }
}

interface PostgresLikeClient {
  query<Row extends Record<string, unknown>>(statement: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>
}

interface MigrationRow extends Record<string, unknown> {
  migration_id: string
  tenant_id: string
  direct_account_id: string
  authorizer_app_id: string
  status: string
  change_reason: string
  created_at: string
  confirmed_at: string | null
  completed_at: string | null
}

export class PostgresWechatDirectMigrationStore implements WechatDirectMigrationStore {
  constructor(private readonly client: PostgresLikeClient) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_wechat_direct_migration (
      migration_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      direct_account_id TEXT NOT NULL,
      authorizer_app_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      change_reason TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL,
      confirmed_at BIGINT,
      completed_at BIGINT
    )`)
  }

  async save(record: WechatDirectMigrationRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO proma_wechat_direct_migration
         (migration_id, tenant_id, direct_account_id, authorizer_app_id, status, change_reason, created_at, confirmed_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (migration_id) DO UPDATE SET
         status = $5, change_reason = $6, confirmed_at = $8, completed_at = $9`,
      [record.migrationId, record.tenantId, record.directAccountId, record.authorizerAppId, record.status, record.changeReason, record.createdAt, record.confirmedAt ?? null, record.completedAt ?? null],
    )
  }

  async load(migrationId: string): Promise<WechatDirectMigrationRecord | undefined> {
    const result = await this.client.query<MigrationRow>('SELECT * FROM proma_wechat_direct_migration WHERE migration_id = $1', [migrationId])
    return result.rows[0] ? this.decode(result.rows[0]) : undefined
  }

  async listByAuthorizer(authorizerAppId: string): Promise<WechatDirectMigrationRecord[]> {
    const result = await this.client.query<MigrationRow>('SELECT * FROM proma_wechat_direct_migration WHERE authorizer_app_id = $1 ORDER BY created_at ASC', [authorizerAppId])
    return result.rows.map((row) => this.decode(row))
  }

  async listByDirectAccount(directAccountId: string): Promise<WechatDirectMigrationRecord[]> {
    const result = await this.client.query<MigrationRow>('SELECT * FROM proma_wechat_direct_migration WHERE direct_account_id = $1 ORDER BY created_at ASC', [directAccountId])
    return result.rows.map((row) => this.decode(row))
  }

  async listByTenant(tenantId: string): Promise<WechatDirectMigrationRecord[]> {
    const result = await this.client.query<MigrationRow>('SELECT * FROM proma_wechat_direct_migration WHERE tenant_id = $1 ORDER BY created_at ASC', [tenantId])
    return result.rows.map((row) => this.decode(row))
  }

  private decode(row: MigrationRow): WechatDirectMigrationRecord {
    const status = row.status
    return {
      migrationId: row.migration_id,
      tenantId: row.tenant_id,
      directAccountId: row.direct_account_id,
      authorizerAppId: row.authorizer_app_id,
      status: status === 'completed' || status === 'rolled_back' || status === 'superseded' ? status : 'pending',
      changeReason: row.change_reason,
      createdAt: Number(row.created_at),
      confirmedAt: row.confirmed_at === null ? undefined : Number(row.confirmed_at),
      completedAt: row.completed_at === null ? undefined : Number(row.completed_at),
    }
  }
}

export class WechatMigrationError extends Error {}

export interface WechatMigrationServiceOptions {
  migrationStore: WechatDirectMigrationStore
  authorizerStore: WechatAuthorizerStore
  authorizationService: WechatAuthorizationService
  now?: () => number
  newId?: () => string
  logger?: { info(message: string): void; warn(message: string): void }
}

export class WechatMigrationService {
  private readonly now: () => number
  private readonly newId: () => string
  private readonly logger: NonNullable<WechatMigrationServiceOptions['logger']>

  constructor(private readonly options: WechatMigrationServiceOptions) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.logger = options.logger ?? { info: () => undefined, warn: () => undefined }
  }

  /**
   * 发起迁移（向导第一步：确认绑定关系）。
   * 规则：目标 authorizer 必须属于当前租户且 active；一个 authorizer 同时只允许一条未完成迁移；
   * 同一 directAccountId 重复迁移必须给 changeReason，旧记录标记 superseded（保留审计）。
   */
  async createMigration(input: { tenantId: string; directAccountId: string; authorizerAppId: string; changeReason?: string }): Promise<WechatDirectMigrationRecord> {
    if (!input.directAccountId || !input.authorizerAppId) throw new WechatMigrationError('迁移需要明确的 directAccountId 与 authorizerAppId')
    // 目标账号必须本租户 active（复用租户守卫，跨租户/撤权一律拒绝）
    await this.options.authorizationService.assertAuthorizerUsable(input.authorizerAppId, input.tenantId)

    // 同一 directAccountId 的历史：pending 不允许叠加；completed 重复迁移必须显式 changeReason，
    // 且旧记录标记 superseded（不删除，审计保留）。
    const history = await this.options.migrationStore.listByDirectAccount(input.directAccountId)
    const previous = history.find((record) => record.status === 'pending' || record.status === 'completed')
    if (previous?.status === 'pending') {
      throw new WechatMigrationError('该 direct 账号已有进行中的迁移，请勿重复发起')
    }
    if (previous?.status === 'completed' && !input.changeReason) {
      throw new WechatMigrationError('该 direct 账号已迁移过：重复迁移必须提供 changeReason')
    }

    // 不可静默换绑：该 authorizer 已有其他 direct 账号的 active 绑定 → 拒绝。
    // 同一 direct 账号换绑（previous 将被 superseded）不受此限，因为其旧绑定随即失效。
    const existingForAuthorizer = await this.options.migrationStore.listByAuthorizer(input.authorizerAppId)
    const foreignBinding = existingForAuthorizer.find(
      (record) => (record.status === 'pending' || record.status === 'completed') && record.directAccountId !== input.directAccountId,
    )
    if (foreignBinding) {
      throw new WechatMigrationError(`该公众号已绑定 direct 账号 ${foreignBinding.directAccountId}，不可静默换绑：请先回滚或显式换绑`)
    }

    if (previous?.status === 'completed') {
      await this.options.migrationStore.save({ ...previous, status: 'superseded' })
      this.logger.info(`[WeChat] 迁移记录已 superseded（migration=${previous.migrationId}，原因=${input.changeReason}）`)
    }

    const record: WechatDirectMigrationRecord = {
      migrationId: this.newId(),
      tenantId: input.tenantId,
      directAccountId: input.directAccountId,
      authorizerAppId: input.authorizerAppId,
      status: 'pending',
      changeReason: input.changeReason ?? '',
      createdAt: this.now(),
    }
    await this.options.migrationStore.save(record)
    this.logger.info(`[WeChat] 迁移已发起（direct=${input.directAccountId} → authorizer=${input.authorizerAppId}，tenant=${input.tenantId}）`)
    return record
  }

  /** 向导第二步：商家在平台侧完成授权核验后确认迁移（pending → completed）。 */
  async confirmMigration(migrationId: string, tenantId: string): Promise<WechatDirectMigrationRecord> {
    const record = await this.loadOwned(migrationId, tenantId)
    if (record.status !== 'pending') throw new WechatMigrationError(`迁移状态不允许确认：${record.status}`)
    // 完成前再核验一次平台凭据可用（防止确认后才发现 token 不通）
    await this.options.authorizationService.assertAuthorizerUsable(record.authorizerAppId, record.tenantId)
    const completed: WechatDirectMigrationRecord = { ...record, status: 'completed', confirmedAt: this.now(), completedAt: this.now() }
    await this.options.migrationStore.save(completed)
    this.logger.info(`[WeChat] 迁移已完成（migration=${migrationId}）`)
    return completed
  }

  /** 回滚：completed/pending → rolled_back。历史数据不受影响（绑定本就是元数据）。 */
  async rollbackMigration(migrationId: string, tenantId: string, reason: string): Promise<WechatDirectMigrationRecord> {
    if (!reason) throw new WechatMigrationError('回滚必须提供原因')
    const record = await this.loadOwned(migrationId, tenantId)
    if (record.status === 'rolled_back' || record.status === 'superseded') throw new WechatMigrationError(`迁移状态不允许回滚：${record.status}`)
    const rolledBack: WechatDirectMigrationRecord = { ...record, status: 'rolled_back', changeReason: reason }
    await this.options.migrationStore.save(rolledBack)
    this.logger.warn(`[WeChat] 迁移已回滚（migration=${migrationId}，原因=${reason}）`)
    return rolledBack
  }

  /**
   * 旧 Secret 可安全删除的判定：存在 completed 迁移，且平台侧 token 实际可取。
   * 返回 true 时 Electron 侧才可删除本地 appsecret；服务端不触达本地 secret。
   */
  async canDeleteLegacySecret(directAccountId: string, tenantId: string): Promise<boolean> {
    const history = await this.options.migrationStore.listByDirectAccount(directAccountId)
    const completed = history.find((record) => record.status === 'completed' && record.tenantId === tenantId)
    if (!completed) return false
    try {
      await this.options.authorizationService.assertAuthorizerUsable(completed.authorizerAppId, tenantId)
      return true
    } catch (error) {
      if (error instanceof WechatAuthorizerUnavailableError) return false
      throw error
    }
  }

  async listMigrations(tenantId: string): Promise<WechatDirectMigrationRecord[]> {
    return this.options.migrationStore.listByTenant(tenantId)
  }

  private async loadOwned(migrationId: string, tenantId: string): Promise<WechatDirectMigrationRecord> {
    const record = await this.options.migrationStore.load(migrationId)
    if (!record || record.tenantId !== tenantId) throw new WechatMigrationError('迁移记录不存在或不属于当前租户')
    return record
  }
}
