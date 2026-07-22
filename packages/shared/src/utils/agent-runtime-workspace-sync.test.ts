import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createAgentRuntimeWorkspaceObjectKey,
  createAgentRuntimeWorkspaceObjectPrefix,
  InMemoryAgentRuntimeObjectStore,
} from './agent-runtime-object-storage'
import {
  materializeAgentRuntimeWorkspace,
  syncAgentRuntimeWorkspaceToObjectStore,
} from './agent-runtime-workspace-sync'

const scope = { tenantId: 'tenant-a', userId: 'user-a', workspaceSlug: 'main' }
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('Agent runtime workspace sync', () => {
  test('given local workspace files then sync uploads them with tenant scoped keys', async () => {
    const dir = await tempWorkspace()
    const store = new InMemoryAgentRuntimeObjectStore()
    await writeFile(join(dir, 'README.md'), 'hello')
    await mkdirp(join(dir, 'src'))
    await writeFile(join(dir, 'src', 'index.ts'), 'export const ok = true\n')

    const result = await syncAgentRuntimeWorkspaceToObjectStore({
      ...scope,
      localDir: dir,
      objectStore: store,
      contentType: 'text/plain',
    })

    expect(result.files.map((file) => file.key)).toEqual([
      createAgentRuntimeWorkspaceObjectKey({ ...scope, relativePath: 'README.md' }),
      createAgentRuntimeWorkspaceObjectKey({ ...scope, relativePath: 'src/index.ts' }),
    ])
    expect((await store.getObject(result.files[0]!.key))?.contentType).toBe('text/plain')
  })

  test('given object store files then materialize writes them to local workspace', async () => {
    const dir = await tempWorkspace()
    const store = new InMemoryAgentRuntimeObjectStore()
    await store.putObject({
      key: createAgentRuntimeWorkspaceObjectKey({ ...scope, relativePath: 'src/index.ts' }),
      body: new TextEncoder().encode('export const ok = true\n'),
    })

    const result = await materializeAgentRuntimeWorkspace({
      ...scope,
      localDir: dir,
      objectStore: store,
    })

    expect(result.files).toHaveLength(1)
    expect(await readFile(join(dir, 'src', 'index.ts'), 'utf8')).toBe('export const ok = true\n')
  })

  test('given unsafe object key then materialize rejects path traversal', async () => {
    const dir = await tempWorkspace()
    const store = new InMemoryAgentRuntimeObjectStore()
    await store.putObject({
      key: `${createAgentRuntimeWorkspaceObjectPrefix(scope, scope.workspaceSlug)}/..%2Fsecret.txt`,
      body: new TextEncoder().encode('secret'),
    })

    await expect(materializeAgentRuntimeWorkspace({
      ...scope,
      localDir: dir,
      objectStore: store,
    })).rejects.toThrow('不安全路径片段')
  })

  test('given symlink in local workspace then sync rejects it', async () => {
    const dir = await tempWorkspace()
    const store = new InMemoryAgentRuntimeObjectStore()
    await writeFile(join(dir, 'target.txt'), 'target')
    await symlink(join(dir, 'target.txt'), join(dir, 'link.txt'))

    await expect(syncAgentRuntimeWorkspaceToObjectStore({
      ...scope,
      localDir: dir,
      objectStore: store,
    })).rejects.toThrow('拒绝 symlink')
  })
})

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'proma-runtime-workspace-'))
  tempDirs.push(dir)
  return dir
}

async function mkdirp(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}
