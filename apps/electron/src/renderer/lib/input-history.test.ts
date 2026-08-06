import { describe, expect, test } from 'bun:test'
import { navigateInputHistory, normalizeInputHistory, type InputHistoryNavigationResult } from './input-history'

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

  test('given a full up then down traversal it returns to the draft (empty) at the end', () => {
    // 空草稿：向上翻到底，再向下逐步回到最新，最后恢复空草稿
    let state: InputHistoryNavigationResult = { index: -1, draft: '', value: '' }
    // 向上翻到最旧（逐级）
    state = navigateInputHistory(['第一', '第二', '第三'], state, '', 'previous')!
    expect(state).toEqual({ index: 0, draft: '', value: '第三' })
    state = navigateInputHistory(['第一', '第二', '第三'], state, '第三', 'previous')!
    expect(state.value).toBe('第二')
    state = navigateInputHistory(['第一', '第二', '第三'], state, '第二', 'previous')!
    expect(state.value).toBe('第一')
    expect(state.index).toBe(2)
    // 向下逐级（每次前进一步，不会跨级）
    state = navigateInputHistory(['第一', '第二', '第三'], state, '第一', 'next')!
    expect(state).toEqual({ index: 1, draft: '', value: '第二' })
    state = navigateInputHistory(['第一', '第二', '第三'], state, '第二', 'next')!
    expect(state).toEqual({ index: 0, draft: '', value: '第三' })
    // 最新再向下 -> 恢复到空草稿
    state = navigateInputHistory(['第一', '第二', '第三'], state, '第三', 'next')!
    expect(state).toEqual({ index: -1, draft: '', value: '' })
  })

  test('given a draft then traversal restores the draft intact', () => {
    // 非空草稿：先输入草稿再上翻，向下恢复应回到草稿
    const state = navigateInputHistory(['第一', '第二'], { index: -1, draft: '' }, '我的草稿', 'previous')!
    expect(state).toEqual({ index: 0, draft: '我的草稿', value: '第二' })
    // 用同样的 state 再一次 next（index 0 -> 恢复草稿）
    const restored = navigateInputHistory(['第一', '第二'], state, '第二', 'next')!
    expect(restored).toEqual({ index: -1, draft: '我的草稿', value: '我的草稿' })
  })
})
