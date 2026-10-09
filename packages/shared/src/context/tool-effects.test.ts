import { describe, expect, test } from 'bun:test'
import { normalizeToolEffects, isIndependentReadCandidate } from './tool-effects'

const read = { version: 1 as const, resources: [{ kind: 'filesystem' as const, mode: 'read' as const, pathParameter: 'file_path', scope: 'path' as const }], replay: 'idempotent_read' as const }
const unknown = { version: 1, resources: [{ kind: 'unknown' }], replay: 'never' } as const

describe('effects声明不是执行许可', () => {
  test('读取候选与目录创建写入可解析，值独立', () => {
    const result = normalizeToolEffects(read)
    expect(result).toEqual(read)
    expect(isIndependentReadCandidate(result)).toBe(true)
    read.resources[0]!.pathParameter = 'changed'
    expect(result.resources[0]).toMatchObject({ pathParameter: 'file_path' })
    read.resources[0]!.pathParameter = 'file_path'
    const write = normalizeToolEffects({ ...read, resources: [{ ...read.resources[0], mode: 'write', scope: 'path-and-ancestors' }], replay: 'never' })
    expect(write.resources[0]).toMatchObject({ mode: 'write', scope: 'path-and-ancestors' })
    expect(isIndependentReadCandidate(write)).toBe(false)
  })
  for (const [name, input] of [
    ['缺失', undefined], ['空', null], ['数组', []], ['版本', { ...read, version: 2 }],
    ['零资源', { ...read, resources: [] }], ['额外字段', { ...read, trusted: true }],
    ['资源额外字段', { ...read, resources: [{ ...read.resources[0], root: '/' }] }],
    ['无scope', { ...read, resources: [{ kind: 'filesystem', mode: 'read', pathParameter: 'file_path' }] }],
    ['动态参数', { ...read, resources: [{ ...read.resources[0], pathParameter: 'a.b' }] }],
    ['未知重放', { ...read, replay: 'always' }],
    ['写入重放', { ...read, resources: [{ ...read.resources[0], mode: 'write' }] }],
    ['未知资源重放', { ...read, resources: [{ kind: 'unknown' }] }],
    ['稀疏数组', { ...read, resources: Array(2) }],
    ['隐藏字段', Object.defineProperty({ ...read }, 'trusted', { value: true })],
    ['符号字段', { ...read, [Symbol('trusted')]: true }],
    ['继承', Object.create(read)], ['继承资源', { ...read, resources: [Object.create(read.resources[0]!)] }],
    ['原型参数', { ...read, resources: [{ ...read.resources[0], pathParameter: '__proto__' }] }],
  ] as const) {
    test(`保守unknown：${name}`, () => {
      expect(normalizeToolEffects(input)).toEqual(unknown)
      expect(isIndependentReadCandidate(input)).toBe(false)
    })
  }
  test('不调用声明getter；不把序列化效果当鉴权', () => {
    let reads = 0
    const input = { ...read, get replay() { reads++; return 'idempotent_read' } }
    expect(normalizeToolEffects(input)).toEqual(unknown)
    expect(reads).toBe(0)
    expect(normalizeToolEffects({ ...read, replay: { toString: () => { reads++; return 'idempotent_read' } } })).toEqual(unknown)
    expect(reads).toBe(0)
    expect(normalizeToolEffects(unknown)).toEqual(unknown)
  })
})
