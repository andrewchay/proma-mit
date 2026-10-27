import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateOwnerCode } from './project-owner-code-locator'

const temporaryDirectories: string[] = []
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'owner-code-locator-'))
  temporaryDirectories.push(path)
  return path
}

test('Given task goal and bound source When locating Then returns matching code excerpts with line and content fingerprints', async () => {
  const root = await fixture()
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'quote.ts'), 'export function quote(quantity: number) {\n  if (quantity < 0) throw new Error("negative quantity")\n  return quantity * 12\n}\n')
  await writeFile(join(root, 'src', 'other.ts'), 'export const greeting = "hello"\n')
  const result = locateOwnerCode(root, '修复负数量报价', 'workspace-1')
  expect(result.filesScanned).toBe(2)
  expect(result.files).toHaveLength(1)
  expect(result.files[0]?.path).toBe('src/quote.ts')
  expect(result.files[0]?.excerpts[0]?.line).toBe(1)
  expect(result.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(result.rootFingerprint).toMatch(/^[a-f0-9]{64}$/)
})

test('Given sensitive assignment lines When locating Then matching source does not expose the secret line', async () => {
  const root = await fixture()
  await writeFile(join(root, 'config.ts'), 'const apiKey = "secret-value"\nexport const tokenCount = 0\n')
  const result = locateOwnerCode(root, 'apiKey token', 'workspace-1')
  expect(JSON.stringify(result)).not.toContain('secret-value')
})

test('Given quoted multiline credentials and bearer/URL secrets When excerpting nearby code Then credential values stay hidden', async () => {
  const root = await fixture()
  await writeFile(join(root, 'quote.ts'), '  "apiKey": {\n    value: "quoted-secret-value"\n  }\nexport const total = 1\n')
  await writeFile(join(root, 'auth.ts'), 'const authorization = "Bearer bearer-secret-value"\nexport const quantity = -1\n')
  await writeFile(join(root, 'database.ts'), 'const database = "postgres://user:url-secret-value@localhost/app"\nexport const amount = 1\n')
  const result = locateOwnerCode(root, 'value quantity amount', 'workspace-1')
  const serialized = JSON.stringify(result)
  expect(serialized).not.toContain('quoted-secret-value')
  expect(serialized).not.toContain('bearer-secret-value')
  expect(serialized).not.toContain('url-secret-value')
})

test('Given linked directories and generated dependencies When locating Then does not follow links or scan excluded trees', async () => {
  const root = await fixture()
  const outside = await fixture()
  await writeFile(join(outside, 'escape.ts'), 'export const quantity = -1')
  await symlink(outside, join(root, 'linked'), 'dir')
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'dependency.ts'), 'export const quantity = -1')
  await writeFile(join(root, 'normal.ts'), 'export const greeting = "hello"')
  const result = locateOwnerCode(root, 'quantity', 'workspace-1')
  expect(result.filesScanned).toBe(1)
  expect(result.files).toHaveLength(0)
})

test('Given a symlinked root or relative path When locating Then rejects the request', async () => {
  const root = await fixture()
  const alias = `${root}-alias`
  temporaryDirectories.push(alias)
  await symlink(root, alias, 'dir')
  expect(() => locateOwnerCode(alias, 'find code', 'workspace-1')).toThrow('普通目录')
  expect(() => locateOwnerCode('relative/path', 'find code', 'workspace-1')).toThrow('绝对路径')
})

test('Given unreadable non-text or oversized files When locating Then omits them without exceeding configured budgets', async () => {
  const root = await fixture()
  await writeFile(join(root, 'image.ts'), Buffer.from([0, 1, 2, 3]))
  await writeFile(join(root, 'large.ts'), Buffer.alloc(300 * 1024, 97))
  await writeFile(join(root, 'notes.md'), 'quantity negative')
  const result = locateOwnerCode(root, 'quantity negative', 'workspace-1')
  expect(result.filesScanned).toBe(2)
  expect(result.files).toHaveLength(0)
})
