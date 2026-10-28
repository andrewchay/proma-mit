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
  const bundle = await import('../../../../resources/opendesign-references.json')
  expect(bundle.revision).toBe(catalog.revision)
  expect(bundle.license).toBe(catalog.license)
  const builder = readFileSync(new URL('../../../../electron-builder.yml', import.meta.url), 'utf8')
  expect(builder).toContain('resources/opendesign-LICENSE.txt')
  expect(readFileSync(new URL('../../../../resources/opendesign-LICENSE.txt', import.meta.url), 'utf8')).toContain('Apache License')
  expect(Object.keys(bundle.entries).sort()).toEqual(catalog.entries.map(entry => entry.id).sort())
  for (const entry of Object.values(bundle.entries)) {
    expect(entry.design).toContain('# ')
    expect(entry.tokens).toContain(':root')
  }
})
