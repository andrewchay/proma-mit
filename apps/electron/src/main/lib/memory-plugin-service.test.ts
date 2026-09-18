import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMemoryItem,
  listMemoryItems,
  resetMemoryItemsStorageState,
  type MemoryItem,
} from './memory-plugin-service'

let testDir = ''

function getDataDir(): string {
  return join(testDir, 'plugins', 'proma-memory', 'data')
}

function getItemsPath(): string {
  return join(getDataDir(), 'items.json')
}

function writeItemsRaw(content: string): void {
  mkdirSync(getDataDir(), { recursive: true })
  writeFileSync(getItemsPath(), content)
}

function createInput(title: string): Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    title,
    content: '内容',
    kind: 'fact',
    tags: [],
    confidence: 0.8,
    sourceRunId: null,
    sourceSessionId: null,
  }
}

beforeEach(() => {
  testDir = join(tmpdir(), `gravitas-memory-plugin-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  resetMemoryItemsStorageState()
})

afterEach(() => {
  resetMemoryItemsStorageState()
  delete process.env.PROMA_TEST_CONFIG_DIR
  rmSync(testDir, { recursive: true, force: true })
})

describe('memory-plugin-service items.json 持久化', () => {
  it('items.json 损坏时失败关闭，并阻止后续保存覆盖原文件', () => {
    const corrupted = '{"not":"complete"'
    writeItemsRaw(corrupted)

    expect(() => listMemoryItems()).toThrow('已停止写入以避免覆盖原数据')
    expect(() => createMemoryItem(createInput('不应写入'))).toThrow('已停止写入以避免覆盖原数据')
    expect(readFileSync(getItemsPath(), 'utf-8')).toBe(corrupted)
    expect(readdirSync(getDataDir()).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('只有显式修复文件并重置状态后才恢复读取，且兼容旧版数组条目', () => {
    writeItemsRaw('not-json')
    expect(() => listMemoryItems()).toThrow()

    const legacyItem: MemoryItem = {
      id: 'legacy-1',
      title: '旧格式记忆',
      content: '没有治理阶段新增的可选字段',
      kind: 'preference',
      tags: ['legacy'],
      confidence: 0.7,
      sourceRunId: null,
      sourceSessionId: null,
      createdAt: 1,
      updatedAt: 1,
    }
    writeItemsRaw(JSON.stringify([legacyItem]))

    // 修复磁盘文件不会绕过已锁定的失败状态，必须由调用方明确重置。
    expect(() => listMemoryItems()).toThrow('已停止写入以避免覆盖原数据')
    resetMemoryItemsStorageState()

    expect(listMemoryItems()).toEqual([legacyItem])
  })

  it('保存通过同目录临时文件原子替换，并清理临时文件', () => {
    const created = createMemoryItem(createInput('原子保存'))
    const stored = JSON.parse(readFileSync(getItemsPath(), 'utf-8')) as MemoryItem[]

    expect(stored).toHaveLength(1)
    expect(stored[0]?.id).toBe(created.id)
    expect(readdirSync(getDataDir()).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('磁盘文件在缓存加载后损坏时，后续保存仍拒绝覆盖', () => {
    createMemoryItem(createInput('已缓存'))
    const corrupted = '{broken-after-load'
    writeItemsRaw(corrupted)

    expect(() => createMemoryItem(createInput('不应覆盖'))).toThrow('已停止写入以避免覆盖原数据')
    expect(readFileSync(getItemsPath(), 'utf-8')).toBe(corrupted)
  })
})
