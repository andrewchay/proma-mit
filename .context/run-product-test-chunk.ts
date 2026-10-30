import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const offset = Number(process.argv[2]), limit = Number(process.argv[3])
if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('用法：bun .context/run-product-test-chunk.ts <offset> <limit>')
const listing = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', 'apps', 'packages', 'scripts'])
if (listing.exitCode !== 0) throw new Error('无法读取产品测试清单')
const files = [...new Set(listing.stdout.toString().split('\0'))]
  .filter(path => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path))
  .sort()
const selected = files.slice(offset, offset + limit)
console.log(`产品测试分片：${offset}-${offset + selected.length - 1} / ${files.length}`)
let failures = 0
for (const [index, path] of selected.entries()) {
  const directory = mkdtempSync(join(tmpdir(), 'gravitas-test-'))
  console.log(`[${offset + index}] ${path}`)
  try {
    const child = Bun.spawn([process.execPath, 'test', './' + path], {
      env: { ...process.env, PROMA_TEST_CONFIG_DIR: directory },
      stdout: 'inherit', stderr: 'inherit',
    })
    if (await child.exited !== 0) failures++
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
console.log(`分片测试文件: ${selected.length}，失败文件: ${failures}`)
process.exitCode = failures ? 1 : 0
