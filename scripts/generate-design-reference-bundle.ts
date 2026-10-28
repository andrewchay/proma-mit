/** 从指定的干净 OpenDesign 检出生成只读设计参考，保留来源版本与许可证。 */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import catalog from '../apps/electron/resources/opendesign-brand-catalog.json'

const source = process.argv[2]
if (!source) throw new Error('用法：bun scripts/generate-design-reference-bundle.ts <OpenDesign 仓库路径>')
const root = resolve(import.meta.dir, '..')
const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (revision !== catalog.revision) throw new Error('OpenDesign 版本与目录版本不一致')
execFileSync('git', ['-C', source, 'diff', '--quiet', 'HEAD', '--', 'design-systems', 'LICENSE'])
const entries: Record<string, { design: string; tokens: string }> = {}
for (const entry of catalog.entries) {
  const dir = resolve(source, 'design-systems', entry.id)
  entries[entry.id] = {
    design: await readFile(resolve(dir, 'DESIGN.md'), 'utf8'),
    tokens: await readFile(resolve(dir, 'tokens.css'), 'utf8'),
  }
}
await writeFile(resolve(root, 'apps/electron/resources/opendesign-references.json'), JSON.stringify({ revision, license: catalog.license, entries }) + '\n')
await writeFile(resolve(root, 'apps/electron/resources/opendesign-LICENSE.txt'), await readFile(resolve(source, 'LICENSE')))
