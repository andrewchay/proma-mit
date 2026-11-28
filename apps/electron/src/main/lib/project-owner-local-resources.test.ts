import { expect, test } from 'bun:test'
import { createOwnerPressureGate } from './project-owner-local-resources'

test('Given CPU 短暂繁忙或持续饱和 When 评估资源 Then 只对持续压力排队并在负载稳定后恢复', () => {
  const gate = createOwnerPressureGate()
  const total = 16 * 1024 ** 3
  expect(gate(0.95, undefined, total)).toBeNull()
  expect(gate(0.50, undefined, total)).toBeNull()
  expect(gate(0.95, undefined, total)).toBeNull()
  expect(gate(0.95, undefined, total)).toBe('cpu')
  expect(gate(0.65, undefined, total)).toBe('cpu')
  expect(gate(0.75, undefined, total)).toBe('cpu')
  expect(gate(0.65, undefined, total)).toBe('cpu')
  expect(gate(0.65, undefined, total)).toBeNull()
})

test('Given 可用内存不足 When 等待资源恢复 Then 保留恢复余量且不误判一次未完成的取样', () => {
  const gate = createOwnerPressureGate()
  const mib = 1024 ** 2, total = 16 * 1024 * mib
  expect(gate(undefined, 500 * mib, total)).toBe('memory')
  expect(gate(undefined, undefined, total)).toBe('memory')
  expect(gate(undefined, 900 * mib, total)).toBe('memory')
  expect(gate(undefined, 1000 * mib, total)).toBeNull()
  expect(gate(undefined, 500 * mib, total)).toBe('memory')
  expect(gate(undefined, null, total)).toBeNull()
})
