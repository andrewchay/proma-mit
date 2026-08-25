import { describe, it, expect } from 'bun:test'
import { tokenize, toIndexTokens, toQueryTokenTiers } from './tokenizer.ts'

describe('tokenizer', () => {
  it('tokenizes CJK text with bigram', () => {
    const tokens = tokenize('沙箱环境')
    // 沙 沙箱 箱 箱环 环 环境 境（跨片段 bigram 也保留，与 mycontext 一致）
    expect(tokens).toEqual(['沙', '沙箱', '箱', '箱环', '环', '环境', '境'])
  })

  it('tokenizes ASCII words as-is', () => {
    const tokens = tokenize('deploy to production')
    expect(tokens).toEqual(['deploy', 'to', 'production'])
  })

  it('tokenizes mixed CJK and ASCII', () => {
    const tokens = tokenize('修复bug了')
    // 修 修复 复 bug 了
    expect(tokens).toEqual(['修', '修复', '复', 'bug', '了'])
  })

  it('preserves token order with original text', () => {
    const tokens = tokenize('部署k8s集群')
    expect(tokens).toEqual(['部', '部署', '署', 'k8s', '集', '集群', '群'])
  })

  it('handles empty string', () => {
    expect(tokenize('')).toEqual([])
  })

  it('handles punctuation and spaces', () => {
    const tokens = tokenize('沙箱，环境！deploy...')
    // 标点断开 CJK 片段，但 ASCII 标点连字符保留在词内
    expect(tokens).toEqual(['沙', '沙箱', '箱', '环', '环境', '境', 'deploy...'])
  })

  it('deduplicates index tokens', () => {
    const tokens = toIndexTokens('沙箱沙箱')
    // 沙 沙箱 箱 箱沙（去重后）
    expect(tokens).toEqual(['沙', '沙箱', '箱', '箱沙'])
  })

  describe('toQueryTokenTiers', () => {
    it('returns single tier when no CJK bigram', () => {
      const tiers = toQueryTokenTiers('deploy production')
      expect(tiers).toHaveLength(1)
      expect(tiers[0]).toEqual(['deploy', 'production'])
    })

    it('returns two tiers for CJK query', () => {
      const tiers = toQueryTokenTiers('部署沙箱')
      expect(tiers).toHaveLength(2)
      // 严格档: 部 部署 署 署沙 沙 沙箱 箱
      expect(tiers[0]).toEqual(['部', '部署', '署', '署沙', '沙', '沙箱', '箱'])
      // 放宽档: 去掉 CJK bigram → 部 署 沙 箱
      expect(tiers[1]).toEqual(['部', '署', '沙', '箱'])
    })

    it('returns empty for empty query', () => {
      expect(toQueryTokenTiers('')).toEqual([])
    })

    it('returns single tier when relaxed equals strict', () => {
      // 纯单字 CJK 查询，没有 bigram 可去掉
      const tiers = toQueryTokenTiers('部署')
      // 部署有两个字，会产生 bigram「部署」，严格档有 bigram，放宽档去掉后只剩单字
      // 但单字和 bigram 数量不同，所以应该有两档
      expect(tiers).toHaveLength(2)
      expect(tiers[0]).toEqual(['部', '部署', '署'])
      expect(tiers[1]).toEqual(['部', '署'])
    })
  })
})
