import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createPackage } from '@electron/asar'
import { buildSync } from 'esbuild'

const electronDir = dirname(require.resolve('electron/package.json'))
const electronPath = join(electronDir, 'dist', readFileSync(join(electronDir, 'path.txt'), 'utf8'))
const electronTest = existsSync(electronPath) ? test : test.skip

electronTest('Given 项目含 asar 文件 When Electron 扫描并再次扫描 Then 保留真实文件元数据及其他文件的变化', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'gravitas-project-asar-'))
  try {
    const root = join(temp, 'root'), input = join(temp, 'input')
    mkdirSync(root); mkdirSync(input)
    writeFileSync(join(input, 'inside.txt'), 'synthetic')
    await createPackage(input, join(root, 'app.asar'))
    writeFileSync(join(root, 'note.txt'), 'before')
    const entry = join(temp, 'entry.ts'), runner = join(temp, 'runner.cjs')
    writeFileSync(entry, `
      import { scanProjectFileChanges } from ${JSON.stringify(join(import.meta.dir, 'project-file-changes.ts'))};
      import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
      (async () => { const root = process.argv[2]; await scanProjectFileChanges('fixture', root); writeFileSync(join(root, 'note.txt'), 'after'); (require('original-fs') as typeof import('node:fs')).appendFileSync(join(root, 'app.asar'), 'x'); const changes = await scanProjectFileChanges('fixture', root); if (!changes.some(item => item.path === 'note.txt' && item.kind === 'modified') || !changes.some(item => item.path === 'app.asar' && item.kind === 'modified') || changes.some(item => item.path.startsWith('app.asar/'))) process.exit(2) })().catch(error => { console.error(error); process.exit(1) });
    `)
    buildSync({ entryPoints: [entry], outfile: runner, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'original-fs'], logLevel: 'silent' })
    const env = { ...process.env, NODE_PATH: dirname(electronDir), ELECTRON_RUN_AS_NODE: '1', PROMA_TEST_CONFIG_DIR: join(temp, 'config') }
    expect(() => execFileSync(electronPath, [runner, root], { env, stdio: 'pipe' })).not.toThrow()
  } finally { rmSync(temp, { recursive: true, force: true }) }
}, 30000)
