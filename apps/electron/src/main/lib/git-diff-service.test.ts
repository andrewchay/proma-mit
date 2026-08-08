import { describe, expect, test, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getUnstagedChanges } from './git-diff-service'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gravitas-gitdiff-${prefix}-`))
  tempDirs.push(dir)
  return dir
}

function write(dir: string, rel: string, content = 'x'): void {
  const full = join(dir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

afterAll(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

describe('getUnstagedChanges（非 Git 项目兜底）', () => {
  test('given non-git dir with files then returns them as untracked session files', async () => {
    const dir = makeTempDir('plain')
    write(dir, 'hello.txt', 'hi')
    write(dir, 'src/app.ts', 'export const x = 1')

    const result = await getUnstagedChanges(dir)

    expect(result.isGitRepo).toBe(false)
    const paths = result.untrackedFiles.map((f) => f.filePath).sort()
    expect(paths).toEqual(['hello.txt', 'src/app.ts'])
    expect(result.files).toEqual([])
  })

  test('given non-git dir with noise dirs then excludes them', async () => {
    const dir = makeTempDir('noise')
    write(dir, 'keep.txt', 'ok')
    write(dir, 'node_modules/pkg/index.js', 'skip me')
    write(dir, 'dist/bundle.js', 'skip me too')

    const result = await getUnstagedChanges(dir)

    const paths = result.untrackedFiles.map((f) => f.filePath)
    expect(paths).toEqual(['keep.txt'])
  })

  test('given empty non-git dir then returns empty result', async () => {
    const dir = makeTempDir('empty')
    const result = await getUnstagedChanges(dir)
    expect(result.isGitRepo).toBe(false)
    expect(result.untrackedFiles).toEqual([])
    expect(result.files).toEqual([])
  })

  test('given non-existent dir then returns empty result (no crash)', async () => {
    const nonexistent = join(tmpdir(), 'gravitas-no-such-dir-xyz')
    const result = await getUnstagedChanges(nonexistent)
    expect(result.isGitRepo).toBe(false)
    expect(result.untrackedFiles).toEqual([])
  })
})
