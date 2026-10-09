import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { dirname, join, parse } from 'node:path'
import type { ToolContext } from './types'
import { bindCoreToolEffects } from './tool-effects'
import { createReadToolDefinition, executeReadTool } from './tool-impls/read-tool'
import { createWriteToolDefinition, executeWriteTool } from './tool-impls/write-tool'
import { createEditToolDefinition, executeEditTool } from './tool-impls/edit-tool'
import { resolveRegisteredToolResources } from './tool-resources'

const root = mkdtempSync(join(tmpdir(), 'gravitas-resources-'))
const cwd = join(root, 'workspace')
mkdirSync(cwd)
writeFileSync(join(cwd, 'data.txt'), 'fixture')
const ctx: ToolContext = { cwd, sessionId: 'fixture' }
const read = bindCoreToolEffects({ ...createReadToolDefinition(), execute: executeReadTool })
const write = bindCoreToolEffects({ ...createWriteToolDefinition(), execute: executeWriteTool })
const edit = bindCoreToolEffects({ ...createEditToolDefinition(), execute: executeEditTool })
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('资源观察不是锁或授权', () => {
  test('实际读/编辑观察普通文件，cwd规范化与身份一致', () => {
    const r = resolveRegisteredToolResources(read, { file_path: 'data.txt' }, ctx)
    expect(r.status).toBe('resolved')
    if (r.status !== 'resolved') throw new Error(r.reason)
    expect(r.resources[0]).toMatchObject({ canonicalPath: realpathSync(join(cwd, 'data.txt')), realCwd: realpathSync(cwd), mode: 'read', targetExists: true, scope: 'path' })
    expect(r.resources[0]?.identity?.inode).toMatch(/^\d+$/)
    const e = resolveRegisteredToolResources(edit, { file_path: 'data.txt' }, ctx)
    expect(e.status).toBe('resolved')
    if (e.status === 'resolved') expect(e.resources[0]?.identity).toEqual(r.resources[0]?.identity)
  })
  test('缺失Write尾部保留，每个不同新文件不会坍缩到ancestor', () => {
    const a = resolveRegisteredToolResources(write, { file_path: 'new/deep/a.txt' }, ctx)
    const b = resolveRegisteredToolResources(write, { file_path: 'new/deep/b.txt' }, ctx)
    expect(a.status).toBe('resolved')
    expect(b.status).toBe('resolved')
    if (a.status !== 'resolved' || b.status !== 'resolved') throw new Error('未解析')
    const ar = a.resources[0]!
    expect(ar.canonicalPath).toBe(join(realpathSync(cwd), 'new/deep/a.txt'))
    expect(ar.existingAncestor).toBe(realpathSync(cwd))
    expect(ar.targetExists).toBe(false)
    expect(ar.identity).toBeUndefined()
    expect(ar.coveredPaths[0]).toBe(ar.canonicalPath)
    expect(ar.coveredPaths).toContain(realpathSync(cwd))
    expect(ar.coveredPaths.at(-1)).toBe(parse(ar.canonicalPath).root)
    expect(ar.canonicalPath).not.toBe(b.resources[0]?.canonicalPath)
  })
  test('现存Write也不裁掉祖先范围', () => {
    const r = resolveRegisteredToolResources(write, { file_path: 'data.txt' }, ctx)
    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') expect(r.resources[0]?.coveredPaths).toContain(dirname(realpathSync(cwd)))
  })
  const aliasTest = process.platform === 'win32' ? test.skip : test
  aliasTest('workspace和文件symlink别名规范化；硬链接身份相同', () => {
    symlinkSync(cwd, join(root, 'workspace-link'))
    symlinkSync('data.txt', join(cwd, 'file-link'))
    linkSync(join(cwd, 'data.txt'), join(cwd, 'hard-link'))
    const original = resolveRegisteredToolResources(read, { file_path: 'data.txt' }, ctx)
    const alias = resolveRegisteredToolResources(read, { file_path: 'file-link' }, { ...ctx, cwd: join(root, 'workspace-link') })
    const hard = resolveRegisteredToolResources(read, { file_path: 'hard-link' }, ctx)
    if (original.status !== 'resolved' || alias.status !== 'resolved' || hard.status !== 'resolved') throw new Error('别名未解析')
    expect(alias.resources[0]?.canonicalPath).toBe(original.resources[0]?.canonicalPath)
    expect(hard.resources[0]?.identity).toEqual(original.resources[0]?.identity)
    expect(hard.resources[0]?.canonicalPath).not.toBe(original.resources[0]?.canonicalPath)
  })
  aliasTest('内部目录symlink下缺失尾部完整重建', () => {
    mkdirSync(join(cwd, 'folder'))
    symlinkSync('folder', join(cwd, 'folder-link'))
    const r = resolveRegisteredToolResources(write, { file_path: 'folder-link/new/a.txt' }, ctx)
    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') expect(r.resources[0]?.canonicalPath).toBe(join(realpathSync(cwd), 'folder/new/a.txt'))
  })
  aliasTest('外部目录symlink和悬空symlink不猜路径', () => {
    mkdirSync(join(root, 'outside'))
    symlinkSync(join(root, 'outside'), join(cwd, 'outside-link'))
    symlinkSync('missing', join(cwd, 'dangling'))
    for (const path of ['outside-link/new/a.txt', 'dangling/a.txt', 'dangling']) expect(resolveRegisteredToolResources(write, { file_path: path }, ctx).status).toBe('unknown')
  })
  for (const [name, tool, path] of [['missing-read', read, 'missing.txt'], ['missing-edit', edit, 'missing.txt'], ['directory-read', read, '.'], ['directory-write', write, '.'], ['directory-edit', edit, '.'], ['file-as-parent', write, 'data.txt/child']] as const) {
    test(`${name}回退unknown`, () => { expect(resolveRegisteredToolResources(tool, { file_path: path }, ctx).status).toBe('unknown') })
  }
  for (const [name, input] of [['空', { file_path: '' }], ['NUL', { file_path: '\0' }], ['数字', { file_path: 1 }], ['越界', { file_path: '../other' }], ['继承', Object.create({ file_path: 'data.txt' })], ['数组', ['data.txt']]] as const) {
    test(`无效输入${name}`, () => { expect(resolveRegisteredToolResources(read, input, ctx).status).toBe('unknown') })
  }
  test('输入/cwd getter不调用；未注册DTO与替换函数unknown', () => {
    let calls = 0
    expect(resolveRegisteredToolResources(read, { get file_path() { calls++; return 'data.txt' } }, ctx).status).toBe('unknown')
    expect(resolveRegisteredToolResources(read, { file_path: 'data.txt' }, { ...ctx, get cwd() { calls++; return cwd } }).status).toBe('unknown')
    expect(calls).toBe(0)
    expect(resolveRegisteredToolResources({ ...read }, { file_path: 'data.txt' }, ctx).status).toBe('unknown')
    const replaced = bindCoreToolEffects({ ...createReadToolDefinition(), execute: executeReadTool })
    replaced.execute = async () => ({ toolCallId: '', content: 'fake' })
    expect(resolveRegisteredToolResources(replaced, { file_path: 'data.txt' }, ctx).status).toBe('unknown')
  })
  aliasTest('特殊socket不是普通文件，禁止当无副作用文件读取候选', async () => {
    const server = createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(join(root, 's'), resolve) })
    try {
      for (const t of [read, write, edit]) expect(resolveRegisteredToolResources(t, { file_path: 's' }, { ...ctx, cwd: root }).status).toBe('unknown')
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
  const permissionTest = process.platform === 'win32' || process.getuid?.() === 0 ? test.skip : test
  permissionTest('EACCES不能被当成缺失路径向上猜测', () => {
    const folder = join(cwd, 'no-access')
    mkdirSync(folder)
    chmodSync(folder, 0)
    try { expect(resolveRegisteredToolResources(write, { file_path: 'no-access/new.txt' }, ctx).status).toBe('unknown') }
    finally { chmodSync(folder, 0o700) }
  })
  test('相对路径按既有工具词法规则处理，但不扩大根范围', () => {
    const r = resolveRegisteredToolResources(read, { file_path: 'missing/../data.txt' }, ctx)
    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') expect(r.resources[0]?.canonicalPath).toBe(realpathSync(join(cwd, 'data.txt')))
  })
  test('非规范绝对缺失路径不伪称已折叠到现存文件', () => {
    expect(resolveRegisteredToolResources(write, { file_path: `${cwd}/never/../data.txt` }, ctx).status).toBe('unknown')
  })
  test('观察与之后文件变化独立，不称为资源租约', () => {
    const path = join(cwd, 'changing')
    writeFileSync(path, 'before')
    const before = resolveRegisteredToolResources(read, { file_path: 'changing' }, ctx)
    expect(before.status).toBe('resolved')
    rmSync(path)
    mkdirSync(path)
    expect(resolveRegisteredToolResources(read, { file_path: 'changing' }, ctx).status).toBe('unknown')
    if (before.status === 'resolved') expect(before.resources[0]?.targetExists).toBe(true)
  })
  test('cwd不存在、相对路径或文件均unknown', () => {
    for (const base of ['relative', join(root, 'missing'), join(cwd, 'data.txt')]) expect(resolveRegisteredToolResources(read, { file_path: 'data.txt' }, { ...ctx, cwd: base }).status).toBe('unknown')
  })
})
