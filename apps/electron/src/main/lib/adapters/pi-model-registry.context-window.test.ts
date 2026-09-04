import { describe, expect, test } from 'bun:test'
import { inferPiContextWindow } from './pi-model-registry'

describe('Pi 模型窗口解析', () => {
  test('Kimi K3 与 K2.6 使用不同的官方上下文窗口', () => {
    expect(inferPiContextWindow('kimi-k3')).toBe(1_000_000)
    expect(inferPiContextWindow('K3')).toBe(1_000_000)
    expect(inferPiContextWindow('kimi-k2.6')).toBe(256_000)
  })
})
