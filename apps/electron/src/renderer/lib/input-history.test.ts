import { describe, expect, test } from 'bun:test'
import { navigateInputHistory, normalizeInputHistory } from './input-history'

describe('输入历史', () => {
  test('given prior commands when ArrowUp then it selects newest command first', () => {
    const result = navigateInputHistory(['第一个', '第二个'], { index: -1, draft: '' }, '未发送草稿', 'previous')
    expect(result).toEqual({ index: 0, draft: '未发送草稿', value: '第二个' })
  })

  test('given a recalled command when ArrowDown reaches the end then it restores the draft', () => {
    const result = navigateInputHistory(['第一个'], { index: 0, draft: '未发送草稿' }, '第一个', 'next')
    expect(result).toEqual({ index: -1, draft: '未发送草稿', value: '未发送草稿' })
  })

  test('given empty or consecutive duplicate commands when normalizing then they are ignored', () => {
    expect(normalizeInputHistory(['', '  第一条  ', '第一条', '第二条'])).toEqual(['第一条', '第二条'])
  })
})
