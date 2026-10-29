/** 从内置 OpenDesign 索引生成渲染进程使用的品牌目录，不包含品牌资产或设计规范。 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const source = await readFile(resolve(root, 'apps/electron/default-skills/design-system-library/references/index.md'), 'utf8')
const entries: Array<{ id: string; name: string; category: string }> = []
let category = ''
for (const line of source.split(/\r?\n/)) {
  const heading = line.match(/^## (.+)$/)
  if (heading) { category = heading[1]!; continue }
  const item = line.match(/^- \*\*([a-z0-9-]+)\*\*（(.+)）$/)
  if (item) {
    if (!category) throw new Error('设计目录条目缺少分类')
    entries.push({ id: item[1]!, name: item[2]!, category })
  } else if (line.startsWith('- **')) throw new Error('设计目录条目格式无法解析')
}
if (!entries.length || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('设计目录为空或 ID 重复')
const catalog = { source: 'OpenDesign design-systems index', revision: 'e03d5c23f308c39f4de7c057568df66c29a84385', license: 'Apache-2.0', entries }
await writeFile(resolve(root, 'apps/electron/resources/opendesign-brand-catalog.json'), JSON.stringify(catalog, null, 2) + '\n')
