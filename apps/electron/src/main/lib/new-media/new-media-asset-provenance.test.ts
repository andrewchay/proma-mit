import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ASSET_PROVENANCE_KIND,
  assertAssetsPublishable,
  checkAssetPublishable,
  getAssetProvenance,
  listAssetProvenances,
  provenanceForGeneratedAsset,
  provenanceForUploadedAsset,
  upsertAssetProvenance,
} from './new-media-asset-provenance'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from './new-media-sqlite-store'

let testDir = ''
beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-provenance-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { await clearNewMediaRecordsForTests() })
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

describe('P4-09 素材来源登记', () => {
  test('上传素材登记来源与许可', async () => {
    const record = await upsertAssetProvenance(provenanceForUploadedAsset({
      assetKey: 'media:MEDIA-1', accountId: 'acc-1', uploadedBy: 'Carol', licenseStatus: 'granted', licenseRef: '摄图网授权 #88',
    }))
    expect(record.source.kind).toBe('uploaded')
    expect(record.source.uploadedBy).toBe('Carol')
    expect(record.license.status).toBe('granted')
    expect(record.aigc.isAigc).toBe(false)
    expect(await getAssetProvenance('media:MEDIA-1', 'acc-1')).toBeDefined()
  })

  test('生成素材必须标记 AIGC 并记录模型', async () => {
    await expect(upsertAssetProvenance({
      assetKey: 'media:GEN-1', accountId: 'acc-1',
      source: { kind: 'generated', generatedByModel: 'gpt-image-2' },
      license: { status: 'granted' }, aigc: { isAigc: false },
    })).rejects.toThrow('生成素材必须标记为 AIGC')

    const record = await upsertAssetProvenance(provenanceForGeneratedAsset({
      assetKey: 'media:GEN-1', accountId: 'acc-1', model: 'gpt-image-2', promptRef: 'prompt-42', labelApplied: true,
    }))
    expect(record.aigc.isAigc).toBe(true)
    expect(record.aigc.model).toBe('gpt-image-2')
    expect(record.source.promptRef).toBe('prompt-42')
  })

  test('授权来源素材必须提供有效许可', async () => {
    await expect(upsertAssetProvenance({
      assetKey: 'media:LIC-1', accountId: 'acc-1',
      source: { kind: 'licensed', origin: 'https://vendor.example/img' },
      license: { status: 'unknown' }, aigc: { isAigc: false },
    })).rejects.toThrow('授权来源素材必须提供有效许可')
  })

  test('同一素材重复登记是更新，保留创建时间', async () => {
    const first = await upsertAssetProvenance(provenanceForUploadedAsset({
      assetKey: 'media:MEDIA-2', accountId: 'acc-1', uploadedBy: 'Carol', licenseStatus: 'missing',
    }), 1_000)
    const second = await upsertAssetProvenance(provenanceForUploadedAsset({
      assetKey: 'media:MEDIA-2', accountId: 'acc-1', uploadedBy: 'Carol', licenseStatus: 'granted', licenseRef: '补签授权',
    }), 2_000)
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.license.status).toBe('granted')
    expect(await listAssetProvenances('acc-1')).toHaveLength(1)
  })

  test('本地绝对路径不进入来源记录', async () => {
    const record = await upsertAssetProvenance(provenanceForUploadedAsset({
      assetKey: 'media:MEDIA-3', accountId: 'acc-1', uploadedBy: 'Carol', licenseStatus: 'granted',
    }))
    expect(JSON.stringify(record)).not.toContain('/Users/')
    expect(record.source.origin).toBeUndefined()
  })
})

describe('P4-09 发布阻断门控', () => {
  test('没有 provenance 的素材直接阻断', () => {
    const check = checkAssetPublishable(undefined, 'media:UNKNOWN', { aigcLabelRequired: true })
    expect(check.publishable).toBe(false)
    expect(check.reason).toBe('no_provenance')
    expect(check.explanation).toContain('禁止外发')
  })

  test('许可 missing / unknown / 过期分别阻断', async () => {
    await upsertAssetProvenance(provenanceForUploadedAsset({
      assetKey: 'media:MISS', accountId: 'acc-1', uploadedBy: 'Carol', licenseStatus: 'missing',
    }))
    await upsertAssetProvenance({
      assetKey: 'media:UNKN', accountId: 'acc-1',
      source: { kind: 'unknown' }, license: { status: 'unknown' }, aigc: { isAigc: false },
    })
    await upsertAssetProvenance({
      assetKey: 'media:EXPIRED', accountId: 'acc-1',
      source: { kind: 'licensed', origin: 'https://vendor.example/a' },
      license: { status: 'granted', licenseRef: 'LIC-1', grantedBy: 'vendor', expiresAt: Date.now() - 86_400_000 },
      aigc: { isAigc: false },
    })

    expect(checkAssetPublishable(await getAssetProvenance('media:MISS', 'acc-1'), 'media:MISS', { aigcLabelRequired: false }).reason).toBe('license_missing')
    expect(checkAssetPublishable(await getAssetProvenance('media:UNKN', 'acc-1'), 'media:UNKN', { aigcLabelRequired: false }).reason).toBe('license_unknown')
    expect(checkAssetPublishable(await getAssetProvenance('media:EXPIRED', 'acc-1'), 'media:EXPIRED', { aigcLabelRequired: false }).reason).toBe('license_expired')
  })

  test('AIGC 素材未应用标识时阻断；平台不要求时不阻断', async () => {
    await upsertAssetProvenance(provenanceForGeneratedAsset({
      assetKey: 'media:GEN-2', accountId: 'acc-1', model: 'gpt-image-2', labelApplied: false,
    }))
    const provenance = await getAssetProvenance('media:GEN-2', 'acc-1')
    expect(checkAssetPublishable(provenance, 'media:GEN-2', { aigcLabelRequired: true }).reason).toBe('aigc_unlabeled')
    expect(checkAssetPublishable(provenance, 'media:GEN-2', { aigcLabelRequired: false }).publishable).toBe(true)
  })

  test('批量断言：任一素材被阻断即抛错并列出全部问题', async () => {
    await upsertAssetProvenance(provenanceForUploadedAsset({
      assetKey: 'media:OK', accountId: 'acc-1', uploadedBy: 'Carol', licenseStatus: 'granted',
    }))
    await upsertAssetProvenance(provenanceForUploadedAsset({
      assetKey: 'media:BAD', accountId: 'acc-1', uploadedBy: 'Carol', licenseStatus: 'missing',
    }))

    await expect(assertAssetsPublishable({ accountId: 'acc-1', assetKeys: [], aigcLabelRequired: false })).rejects.toThrow('必须声明素材清单')
    const error: Error = await assertAssetsPublishable({
      accountId: 'acc-1', assetKeys: ['media:OK', 'media:BAD', 'media:UNKNOWN'], aigcLabelRequired: false,
    }).then(() => { throw new Error('预期阻断') }, (caught: Error) => caught)
    expect(error.message).toContain('media:BAD')
    expect(error.message).toContain('media:UNKNOWN')
    expect(error.message).toContain('未通过外发检查')

    const checks = await assertAssetsPublishable({ accountId: 'acc-1', assetKeys: ['media:OK'], aigcLabelRequired: false })
    expect(checks[0]?.publishable).toBe(true)
  })

  test('跨账号 provenance 互不可见', async () => {
    await upsertAssetProvenance(provenanceForUploadedAsset({
      assetKey: 'media:SHARED', accountId: 'acc-1', uploadedBy: 'Carol', licenseStatus: 'granted',
    }))
    expect(await getAssetProvenance('media:SHARED', 'acc-2')).toBeUndefined()
    await expect(assertAssetsPublishable({ accountId: 'acc-2', assetKeys: ['media:SHARED'], aigcLabelRequired: false })).rejects.toThrow(/没有来源记录/)
  })

  test('provenance 记录持久化并在 kind 注册表登记', async () => {
    await upsertAssetProvenance(provenanceForUploadedAsset({
      assetKey: 'media:PERSIST', accountId: 'acc-1', uploadedBy: 'Carol', licenseStatus: 'granted',
    }))
    closeNewMediaDb()
    expect(await getAssetProvenance('media:PERSIST', 'acc-1')).toBeDefined()
    const { getNewMediaSchemaInfo } = await import('./new-media-sqlite-store')
    const info = await getNewMediaSchemaInfo()
    expect(info.registeredKinds.map((item) => item.kind)).toContain(ASSET_PROVENANCE_KIND)
    expect(info.unknownKinds).toEqual([])
  })
})
