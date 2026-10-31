import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import catalog from '../../../../resources/opendesign-brand-catalog.json'

test('Given 内置设计系统索引 When 生成品牌选择目录 Then 保持来源、分类和条目一致', () => {
  const source = readFileSync(new URL('../../../../default-skills/design-system-library/references/index.md', import.meta.url), 'utf8')
  const entries: Array<{ id: string; name: string; category: string }> = []
  let category = ''
  for (const line of source.split(/\r?\n/)) {
    const heading = line.match(/^## (.+)$/)
    if (heading) { category = heading[1]!; continue }
    const item = line.match(/^- \*\*([a-z0-9-]+)\*\*（(.+)）$/)
    if (item) entries.push({ id: item[1]!, name: item[2]!, category })
    else if (line.startsWith('- **')) throw new Error('设计目录条目格式无法解析')
  }
  expect(catalog.entries).toEqual(entries)
  expect(catalog.entries).toHaveLength(152)
  expect(new Set(catalog.entries.map(entry => entry.id)).size).toBe(catalog.entries.length)
  expect(catalog.license).toBe('Apache-2.0')
})


test('Given 版本固定的设计参考包 When 查看目录 Then 每个条目都有设计说明和令牌', async () => {
  const bundles = await Promise.all([
    import('../../../../resources/opendesign-references-0.json'), import('../../../../resources/opendesign-references-1.json'),
    import('../../../../resources/opendesign-references-2.json'), import('../../../../resources/opendesign-references-3.json'),
  ])
  bundles.forEach((bundle, index) => {
    expect(bundle.revision).toBe(catalog.revision)
    expect(bundle.license).toBe(catalog.license)
    expect(Object.keys(bundle.entries)).toEqual(catalog.entries.slice(index * 38, (index + 1) * 38).map(entry => entry.id))
  })
  const builder = readFileSync(new URL('../../../../electron-builder.yml', import.meta.url), 'utf8')
  for (const file of ['opendesign-brand-catalog.json', 'opendesign-references-0.json', 'opendesign-references-1.json', 'opendesign-references-2.json', 'opendesign-references-3.json', 'opendesign-LICENSE.txt']) {
    expect(builder).toContain(`resources/${file}`)
  }
  expect(readFileSync(new URL('../../../../resources/opendesign-LICENSE.txt', import.meta.url), 'utf8')).toContain('Apache License')
  expect(bundles.flatMap(bundle => Object.keys(bundle.entries)).sort()).toEqual(catalog.entries.map(entry => entry.id).sort())
  for (const entry of bundles.flatMap(bundle => Object.values(bundle.entries))) {
    expect(entry.design).toContain('# ')
    expect(entry.tokens).toContain(':root')
  }
})
