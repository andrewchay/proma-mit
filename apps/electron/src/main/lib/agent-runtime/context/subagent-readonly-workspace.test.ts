import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSubAgentWorkspace } from './subagent-readonly-workspace'

const directories: string[] = []

function temporaryDirectory(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `gravitas-${name}-`))
  directories.push(directory)
  return directory
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true })
  }
})

describe('resolveSubAgentWorkspace', () => {
  test('given a legacy child when no read-only boundary is requested then it preserves the explicit sandbox', () => {
    const parent = temporaryDirectory('parent')
    const sandbox = temporaryDirectory('sandbox')
    const child = join(temporaryDirectory('child-root'), 'child')

    expect(resolveSubAgentWorkspace({
      readOnly: false,
      parentWorkspaceDir: parent,
      explicitWorkspaceDir: sandbox,
      childWorkspaceDir: child,
    })).toBe(sandbox)
    expect(existsSync(child)).toBe(false)
  })

  test('given a read-only TCC child when an explicit cwd is supplied then it uses a new private child directory', () => {
    const parent = temporaryDirectory('parent')
    const untrustedExplicitDirectory = temporaryDirectory('untrusted-cwd')
    const child = join(temporaryDirectory('child-root'), 'child')

    expect(resolveSubAgentWorkspace({
      readOnly: true,
      parentWorkspaceDir: parent,
      explicitWorkspaceDir: untrustedExplicitDirectory,
      childWorkspaceDir: child,
    })).toBe(child)
    expect(existsSync(child)).toBe(true)
  })
})
