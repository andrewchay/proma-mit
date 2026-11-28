import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { buildSync } from 'esbuild'
import type { OwnerRuntimeBrowserRunner, OwnerRuntimeBrowserRunResult } from '../owner-runtime-browser-verifier'

/** 在独立 Electron 进程运行正式验证器，使测试可保留本机真实浏览器回执。 */
export function createOwnerElectronBrowserRunner(directory: string): OwnerRuntimeBrowserRunner {
  const entry = join(directory, 'owner-electron-browser-entry.ts')
  const bundle = join(directory, 'owner-electron-browser-entry.cjs')
  const verifierPath = join(import.meta.dir, '..', 'owner-runtime-browser-verifier.ts')
  writeFileSync(entry, `import { app } from 'electron'
import { basename, dirname, join, relative } from 'node:path'
import { runOwnerRuntimeBrowserAssertions } from ${JSON.stringify(verifierPath)}
app.setPath('userData', join(dirname(process.argv[1]), 'owner-electron-browser-user-data'))
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'))
  const workspaceRoot = dirname(input.filePath)
  const result = await runOwnerRuntimeBrowserAssertions({
    workspaceRoot, relativePath: basename(input.filePath), intents: [],
    resourcePaths: input.resourcePaths?.map(path => relative(workspaceRoot, path)),
    templates: input.templates, timeoutMs: input.timeoutMs,
  })
  process.stdout.write('RESULT:' + JSON.stringify(result) + '\\n', () => app.exit(0))
}).catch(error => { process.stderr.write(String(error.stack || error)); app.exit(1) })`)
  buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const binary = resolve(import.meta.dir, '../../../../../..', 'node_modules/.bin/electron')
  return async input => {
    const { stdout } = await promisify(execFile)(binary, [bundle, Buffer.from(JSON.stringify(input)).toString('base64')], { encoding: 'utf8', timeout: 30_000 })
    const result = stdout.split('\n').find(line => line.startsWith('RESULT:'))
    if (!result) throw new Error('真实Electron没有返回浏览器验证结果')
    return JSON.parse(result.slice('RESULT:'.length)) as OwnerRuntimeBrowserRunResult
  }
}
