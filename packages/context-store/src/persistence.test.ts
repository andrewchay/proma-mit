import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openContextStore, upsertEntity, getEntity } from './index.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(): string { const dir = mkdtempSync(join(tmpdir(), 'gravitas-context-disk-')); dirs.push(dir); return dir }

describe('Context Store 磁盘恢复', () => {
  test('Given 写入索引 When 关闭并重开 Then 实体仍可查询', async () => {
    const path = join(fixture(), 'nested', 'context.db')
    const store = await openContextStore({ path })
    upsertEntity(store, { id: 'task:disk', entityType: 'task', sourceId: 'disk', sourceType: 'test', title: '持久化任务', occurredAt: 1 })
    store.close()
    expect(existsSync(path)).toBe(true)
    const reopened = await openContextStore({ path })
    expect(getEntity(reopened, 'task:disk')?.title).toBe('持久化任务')
    reopened.close()
  })

  test('Given 目标不可写 When 持久化 Then 抛错并保留原文件', async () => {
    const dir = fixture()
    const path = join(dir, 'context.db')
    const store = await openContextStore({ path })
    store.persist()
    const original = readFileSync(path)
    rmSync(path)
    mkdirSync(path)
    expect(() => store.persist()).toThrow()
    rmSync(path, { recursive: true })
    writeFileSync(path, original)
    store.close()
  })

  test('Given 非法工作区 slug When 打开 Then 拒绝路径穿越', async () => {
    await expect(openContextStore({ workspaceSlug: '../escape' })).rejects.toThrow('slug')
  })
})
