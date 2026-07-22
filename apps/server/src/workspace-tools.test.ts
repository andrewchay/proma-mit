import { describe, expect, test } from 'bun:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile } from './workspace-tools.ts'

describe('服务端工作区只读工具', () => {
  test('仅列出和读取工作区范围内的普通文件', async () => {
    const root = `/private/tmp/proma-server-tools-${crypto.randomUUID()}`
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'note.txt'), 'hello')
    expect(await listWorkspaceFiles(root, 'docs')).toEqual([{ path: 'docs/note.txt', kind: 'file', size: 5 }])
    expect(await readWorkspaceFile(root, 'docs/note.txt')).toBe('hello')
    await expect(readWorkspaceFile(root, '../outside.txt')).rejects.toThrow('路径超出工作区范围')
  })

  test('只在工作区已有目录内写入普通文件', async () => {
    const root = `/private/tmp/proma-server-tools-${crypto.randomUUID()}`
    await mkdir(join(root, 'docs'), { recursive: true })
    expect(await writeWorkspaceFile(root, 'docs/new.txt', 'written')).toContain('已写入')
    expect(await readWorkspaceFile(root, 'docs/new.txt')).toBe('written')
    await expect(writeWorkspaceFile(root, '../outside.txt', 'bad')).rejects.toThrow('路径超出工作区范围')
  })

  test('拒绝指向工作区外的符号链接', async () => {
    const root = `/private/tmp/proma-server-tools-${crypto.randomUUID()}`
    await mkdir(root, { recursive: true })
    await symlink('/private/tmp', join(root, 'outside'))
    await expect(readWorkspaceFile(root, 'outside')).rejects.toThrow('符号链接不能指向工作区外')
  })
})
