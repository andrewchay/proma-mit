import { describe, expect, test } from 'bun:test'
import { inferPiContextWindow } from './pi-model-registry'

describe('Pi 模型窗口解析', () => {
  test('未收录的 GPT 别名不会被宽泛推断为 1M', () => {
    expect(inferPiContextWindow('gpt-5.6')).toBe(256_000)
    expect(inferPiContextWindow('gpt-5.6-codex')).toBe(256_000)
  })

  test('Kimi K3 与 K2.6 使用不同的官方上下文窗口', () => {
    expect(inferPiContextWindow('kimi-k3')).toBe(1_000_000)
    expect(inferPiContextWindow('K3')).toBe(1_000_000)
    expect(inferPiContextWindow('kimi-k2.6')).toBe(256_000)
    expect(inferPiContextWindow('kimi-for-coding')).toBe(256_000)
  })
})
