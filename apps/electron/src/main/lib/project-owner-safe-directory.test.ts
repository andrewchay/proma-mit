import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
import { resolveNapiHeaders } from '../../../scripts/resolve-napi-headers'

mock.module('electron', () => buildElectronMock())
const { prepareOwnerTargetDirectories } = await import('./project-owner-safe-directory')
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'owner-safe-directory-')))
let native: { makeDirectories(root: string, relative: string): void }
beforeAll(() => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return
  const source = resolve(import.meta.dir, '../../../resources/owner-safe-directory/owner_safe_directory.c')
  const output = join(directory, 'owner_safe_directory.node'), headers = resolveNapiHeaders(resolve(import.meta.dir, '../../../scripts'))
  const command = process.platform === 'darwin' ? '/usr/bin/xcrun' : 'cc'
  const args = process.platform === 'darwin' ? ['--sdk', 'macosx', 'clang', '-O2', '-dynamiclib', '-undefined', 'dynamic_lookup', '-I', headers, source, '-o', output] : ['-O2', '-shared', '-fPIC', '-I', headers, source, '-o', output]
  execFileSync(command, args)
  native = require(output) as typeof native
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('Given授权的新文件位于缺失目录 When准备工作树 Then安全创建父目录但不创建文件', () => {
  const root = join(directory, 'worktree'); mkdirSync(root)
  prepareOwnerTargetDirectories(root, ['diary/pages/index.html'], ['diary/pages/index.html'], native)
  expect(lstatSync(join(root, 'diary/pages')).isDirectory()).toBe(true)
  expect(existsSync(join(root, 'diary/pages/index.html'))).toBe(false)
  expect(() => prepareOwnerTargetDirectories(root, ['other/file'], ['diary'], native)).toThrow('冻结研发范围')
})

test.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('Given父目录是符号链接 When安全创建 Then拒绝越界且外部不被修改', () => {
  const root = join(directory, 'link-root'), outside = join(directory, 'outside')
  mkdirSync(root); mkdirSync(outside); symlinkSync(outside, join(root, 'diary'))
  expect(() => prepareOwnerTargetDirectories(root, ['diary/new/index.html'], ['diary'], native)).toThrow('符号链接')
  expect(() => native.makeDirectories(root, 'diary/new')).toThrow()
  expect(() => native.makeDirectories(root, '../outside')).toThrow()
  expect(existsSync(join(outside, 'new'))).toBe(false)
})
