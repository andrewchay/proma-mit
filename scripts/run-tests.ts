/**
 * 每个测试文件独立进程：隔离 Bun mock.module、环境变量和模块级单例。
 * 只要有一个子进程失败就返回非零；真实集成测试的 skip 仍原样输出。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  // Owner 集成测试会累积数据及后台调度；互补筛选保证每项只运行一次，
  // 分进程隔离数据库、浏览器和异步任务，避免前一批超时污染后一批。
  const patterns = path === 'apps/electron/src/main/lib/project-owner-quality-actions.test.ts'
    ? (() => {
      const source = readFileSync(path, 'utf8')
      const declarations = source.split('\n').filter(line => /^test(?:\.|\()/.test(line))
      const names = declarations.map(line => {
        const match = line.match(/^test(?:\.[^(]+\([^\n]*?\))?\('([^']+)'/)
        if (!match) throw new Error(`无法识别质量测试名称：${line}`)
        return match[1]!.split('%s').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
      })
      if (new Set(names).size !== names.length) throw new Error('质量测试名称重复，无法安全分组')
      const groups = Array.from({ length: Math.ceil(names.length / 8) }, (_, index) => `^(?:${names.slice(index * 8, index * 8 + 8).join('|')})$`)
      // 动态生成的测试名称无法从静态声明中提取，补集确保它们也会执行。
      groups.push(`^(?!(?:${names.join('|')})$).+$`)
      return groups
    })()
    : path === 'apps/electron/src/renderer/atoms/owner-delivery-flow.integration.test.ts'
      ? ['^Given真实任务服务与旧手动', '^Given真实任务服务与Owner自主', '^(?!Given真实任务服务与(?:旧手动|Owner自主))']
      : [null]
  let fileFailed = false
  for (const pattern of patterns) {
    const directory = mkdtempSync(join(tmpdir(), 'gravitas-test-'))
    try {
      const args = [process.execPath, 'test']
      // Electron 测试使用固定系统读数；资源策略、数据库并发及其断言照常运行。
      if (path.startsWith('apps/electron/')) args.push('--preload', './apps/electron/src/main/lib/testing/mock-owner-host-resources.ts')
      args.push('./' + path)
      if (pattern) args.push('--test-name-pattern', pattern)
      const child = Bun.spawn(args, {
        env: { ...process.env, PROMA_TEST_CONFIG_DIR: directory },
        stdout: 'inherit', stderr: 'inherit',
      })
      if (await child.exited !== 0) fileFailed = true
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
  if (fileFailed) failures++
}
console.log('测试文件: ' + files.length + '，失败文件: ' + failures)
process.exitCode = failures ? 1 : 0
