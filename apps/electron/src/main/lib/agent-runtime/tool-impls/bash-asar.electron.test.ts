import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createPackage } from '@electron/asar'
import { buildSync } from 'esbuild'

const electronDir = dirname(require.resolve('electron/package.json'))
const electronPath = join(electronDir, 'dist', readFileSync(join(electronDir, 'path.txt'), 'utf8'))
const electronTest = existsSync(electronPath) ? test : test.skip

electronTest('Given asar 文件 When 检查可写目录 Then 不展开包内容且仍拒绝包文件的硬链接', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'gravitas-asar-scan-'))
  try {
    const input = join(temp, 'input')
    const root = join(temp, 'root')
    const archive = join(root, 'app.asar')
    const linked = join(temp, 'outside.asar')
    const log = join(temp, 'diagnostics.jsonl')
    mkdirSync(input)
    mkdirSync(root)
    writeFileSync(join(input, 'inside.txt'), 'synthetic')
    await createPackage(input, archive)
    const runner = join(temp, 'runner.cjs')
    const entry = join(temp, 'entry.ts')
    writeFileSync(entry, `
      import { assertNoWritableHardlinks } from ${JSON.stringify(join(import.meta.dir, 'bash-sandbox.ts'))};
      const policy = { writableRoots: [process.argv[2]], writableLiterals: [], denyRoots: [], denyWriteRoots: [], allowAfterDenyRoots: [], finalDenyWriteRoots: [], finalDenyWriteLiterals: [] };
      assertNoWritableHardlinks(policy).then(() => process.exit(0), () => process.exit(3));
    `)
    buildSync({ entryPoints: [entry], outfile: runner, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'original-fs'], logLevel: 'silent' })
    const env = { ...process.env, NODE_PATH: dirname(electronDir), ELECTRON_RUN_AS_NODE: '1', PROMA_TEST_CONFIG_DIR: join(temp, 'config'), GRAVITAS_PERF_DIAGNOSTICS_PATH: log }
    execFileSync(electronPath, [runner, root], { env })
    const records = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(records.find((record) => record.event === 'end')).toMatchObject({ status: 'ok', visited: 2, directories: 1 })
    linkSync(archive, linked)
    expect(() => execFileSync(electronPath, [runner, root], { env, stdio: 'pipe' })).toThrow()
    unlinkSync(linked)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}, 30000)
