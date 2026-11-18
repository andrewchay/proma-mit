import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { buildElectronMock } from '../testing/electron-mock'

mock.module('electron', () => buildElectronMock())
const sharedNode = await import('@gravitas/shared/utils/node')
const originalWriteFileAtomic = sharedNode.writeFileAtomic
let failPersist = false
mock.module('@gravitas/shared/utils/node', () => ({ ...sharedNode, writeFileAtomic: (...args: Parameters<typeof sharedNode.writeFileAtomic>) => {
  if (failPersist) throw new Error('模拟数据库持久化失败')
  return originalWriteFileAtomic(...args)
} }))
const dir = mkdtempSync(join(tmpdir(), 'director-persist-'))
const oldDir = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = dir
const { createDirectorBrand, createDirectorPlan, confirmDirectorPlan, createDirectorXiaohongshuDraft } = await import('./director-workflow')
const { saveDirectorDesign, getLatestDirectorDesign, readDirectorDesign } = await import('./director-design')
const { closeNewMediaDb } = await import('./new-media-sqlite-store')
afterAll(() => { closeNewMediaDb(); if (oldDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = oldDir; rmSync(dir, { recursive: true, force: true }) })

test('数据库保存结果未知时保留素材，后续写盘和重开仍可读取', async () => {
  const brand = await createDirectorBrand('品牌', '资料')
  const plan = await createDirectorPlan(brand.id, 'xiaohongshu', '方案')
  await confirmDirectorPlan(plan.id)
  const draft = await createDirectorXiaohongshuDraft({ planId: plan.id, title: '标题', body: '正文', hashtags: [] })
  const png = PNG.sync.write(new PNG({ width: 1, height: 1 }))
  const svg = '<svg viewBox="0 0 10 10"></svg>'
  try {
    await expect(saveDirectorDesign(draft.id, svg, async () => { failPersist = true; return png })).rejects.toThrow('模拟数据库持久化失败')
    const asset = await getLatestDirectorDesign(draft.id)
    expect(asset).toBeDefined()
    expect((await readDirectorDesign(asset!.id)).png.equals(png)).toBe(true)
    failPersist = false
    await createDirectorBrand('第二品牌', '资料')
    closeNewMediaDb()
    expect((await readDirectorDesign(asset!.id)).svg.toString()).toBe(svg)
  } finally { failPersist = false }
})
