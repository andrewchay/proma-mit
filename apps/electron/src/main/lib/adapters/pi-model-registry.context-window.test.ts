import { describe, expect, test } from 'bun:test'
import { inferPiContextWindow } from './pi-model-registry'

describe('Pi 模型窗口解析', () => {
  test('Codex GPT-5.6 使用 1M 上下文窗口，而非未知模型回退值', () => {
    expect(inferPiContextWindow('gpt-5.6')).toBe(1_000_000)
    expect(inferPiContextWindow('gpt-5.6-codex')).toBe(1_000_000)
  })

  test('Kimi K3 与 K2.6 使用不同的官方上下文窗口', () => {
    expect(inferPiContextWindow('kimi-k3')).toBe(1_000_000)
    expect(inferPiContextWindow('K3')).toBe(1_000_000)
    expect(inferPiContextWindow('kimi-k2.6')).toBe(256_000)
    expect(inferPiContextWindow('kimi-for-coding')).toBe(256_000)
  })
})
