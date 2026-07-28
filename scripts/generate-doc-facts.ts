/** 生成可由 CI 校验的仓库事实摘要，避免代码索引中的版本和测试数量漂移。 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface PackageManifest {
  name: string
  version: string
}

const repositoryRoot = join(import.meta.dir, '..')
const outputPath = join(repositoryRoot, 'docs/generated/repository-facts.md')
const checkOnly = process.argv.includes('--check')

async function readPackageVersion(relativePath: string): Promise<PackageManifest> {
  const raw = await readFile(join(repositoryRoot, relativePath, 'package.json'), 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (!isPackageManifest(parsed)) throw new Error(`${relativePath}/package.json 缺少 name 或 version`)
  return parsed
}

function isPackageManifest(value: unknown): value is PackageManifest {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).name === 'string'
    && typeof (value as Record<string, unknown>).version === 'string'
}

async function countFiles(relativeRoot: string, patterns: string[]): Promise<number> {
  const root = join(repositoryRoot, relativeRoot)
  const files = new Set<string>()
  for (const pattern of patterns) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: root })) {
      if (!file.split('/').includes('node_modules')) files.add(file)
    }
  }
  return files.size
}

const [electron, shared, core, ui] = await Promise.all([
  readPackageVersion('apps/electron'),
  readPackageVersion('packages/shared'),
  readPackageVersion('packages/core'),
  readPackageVersion('packages/ui'),
])
const testFileCount = await countFiles('.', ['**/*.test.ts', '**/*.pw.ts'])
const mainLibraryFileCount = await countFiles('apps/electron/src/main/lib', ['**/*.ts'])
const rendererFileCount = await countFiles('apps/electron/src/renderer', ['**/*.ts', '**/*.tsx'])

const content = `<!-- 此文件由 scripts/generate-doc-facts.ts 自动生成，请勿手工编辑。 -->

# 仓库事实摘要

| 项目 | 当前值 |
|---|---:|
| ${electron.name} | ${electron.version} |
| ${shared.name} | ${shared.version} |
| ${core.name} | ${core.version} |
| ${ui.name} | ${ui.version} |
| Bun 测试 / Playwright 测试文件 | ${testFileCount} |
| Electron 主进程 lib TypeScript 文件 | ${mainLibraryFileCount} |
| Electron 渲染进程 TypeScript/TSX 文件 | ${rendererFileCount} |
`

if (checkOnly) {
  const existing = await readFile(outputPath, 'utf8').catch(() => '')
  if (existing !== content) throw new Error('docs/generated/repository-facts.md 已过期；请运行 bun run docs:generate')
  console.log('文档事实摘要已同步')
} else {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, content, 'utf8')
  console.log(`已生成 ${outputPath}`)
}
