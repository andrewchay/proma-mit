/**
 * 每个测试文件独立进程：隔离 Bun mock.module、环境变量和模块级单例。
 * 只要有一个子进程失败就返回非零；真实集成测试的 skip 仍原样输出。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const listing = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'])
if (listing.exitCode !== 0) throw new Error('无法读取测试文件清单')
const selectors = process.argv.slice(2)
const files = [...new Set(listing.stdout.toString().split('\0'))]
  .filter((path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path))
  .filter((path) => selectors.length === 0 || selectors.some((selector) => path.includes(selector)))
  .sort()
if (!files.length) throw new Error('没有匹配的测试文件')
let failures = 0
for (const path of files) {
  const directory = mkdtempSync(join(tmpdir(), 'gravitas-test-'))
  try {
    const child = Bun.spawn([process.execPath, 'test', './' + path], {
      env: { ...process.env, PROMA_TEST_CONFIG_DIR: directory },
      stdout: 'inherit', stderr: 'inherit',
    })
    if (await child.exited !== 0) failures++
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
console.log('测试文件: ' + files.length + '，失败文件: ' + failures)
process.exitCode = failures ? 1 : 0
