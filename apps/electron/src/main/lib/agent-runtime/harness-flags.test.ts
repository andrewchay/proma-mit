import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_HARNESS_FLAG_STATE,
  HARNESS_FLAGS,
  loadHarnessFlagOverrides,
  parseHarnessFlagOverrides,
  resolveHarnessFlagState,
  saveHarnessFlagOverrides,
} from './harness-flags'

const root = mkdtempSync(join(tmpdir(), 'gravitas-harness-flags-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('harness-flags：单一事实源与严格解析', () => {
  test('登记表只含已知开关，默认值启用且不留新拒绝面', () => {
    expect(HARNESS_FLAGS.map((f) => f.id)).toEqual(['toolScheduling'])
    expect(DEFAULT_HARNESS_FLAG_STATE).toEqual({ toolScheduling: true })
    expect(resolveHarnessFlagState()).toEqual(DEFAULT_HARNESS_FLAG_STATE)
  })
  test('overrides 只收紧语义：显式禁用生效，未提及的保持默认', () => {
    expect(resolveHarnessFlagState(parseHarnessFlagOverrides({ toolScheduling: false }))).toEqual({ toolScheduling: false })
    expect(resolveHarnessFlagState(parseHarnessFlagOverrides({}))).toEqual(DEFAULT_HARNESS_FLAG_STATE)
    expect(parseHarnessFlagOverrides(undefined)).toBeUndefined()
  })
  test('未知字段与非法值拒绝（不静默忽略）', () => {
    expect(() => parseHarnessFlagOverrides({ futureFlag: true })).toThrow('未知 harness flag')
    expect(() => parseHarnessFlagOverrides({ toolScheduling: 'yes' })).toThrow('布尔值')
    expect(() => parseHarnessFlagOverrides([true])).toThrow('对象')
  })
  test('持久化 round-trip；损坏文件原件保留且拒绝加载', async () => {
    const dir = join(root, 'roundtrip')
    expect(await loadHarnessFlagOverrides(dir)).toBeUndefined()
    await saveHarnessFlagOverrides(dir, { toolScheduling: false })
    expect(await loadHarnessFlagOverrides(dir)).toEqual({ toolScheduling: false })
    expect(resolveHarnessFlagState(await loadHarnessFlagOverrides(dir))).toEqual({ toolScheduling: false })

    const corrupt = join(root, 'corrupt')
    await saveHarnessFlagOverrides(corrupt, { toolScheduling: true })
    const path = join(corrupt, 'harness-flags.json')
    writeFileSync(path, '{ not json')
    await expect(loadHarnessFlagOverrides(corrupt)).rejects.toThrow('原件已保留')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
  })
})
