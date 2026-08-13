import { describe, expect, test } from 'bun:test'
import {
  browserObservationNameLimit,
  DEFAULT_BROWSER_OBSERVE_MAX_ELEMENTS,
  isInteractiveAxRole,
  isInteractiveCandidate,
  MAX_BROWSER_OBSERVE_MAX_ELEMENTS,
  MIN_BROWSER_OBSERVE_MAX_ELEMENTS,
  prioritizeBrowserObservationCandidates,
  resolveBrowserObserveMaxElements,
  type BrowserAxCandidate,
} from './browser-observation-policy'

function candidate(role: string, name = '', editable = false): BrowserAxCandidate {
  return { backendNodeId: Math.floor(Math.random() * 1e6), role, name, editable }
}

describe('resolveBrowserObserveMaxElements', () => {
  test('given undefined then the default 240 is returned', () => {
    expect(resolveBrowserObserveMaxElements()).toBe(DEFAULT_BROWSER_OBSERVE_MAX_ELEMENTS)
  })

  test('given a request within bounds then it is clamped to integer', () => {
    expect(resolveBrowserObserveMaxElements(100)).toBe(100)
    expect(resolveBrowserObserveMaxElements(100.7)).toBe(100)
  })

  test('given below-min or above-max then it is clamped', () => {
    expect(resolveBrowserObserveMaxElements(1)).toBe(MIN_BROWSER_OBSERVE_MAX_ELEMENTS)
    expect(resolveBrowserObserveMaxElements(9999)).toBe(MAX_BROWSER_OBSERVE_MAX_ELEMENTS)
  })

  test('given NaN or Infinity then an error is thrown', () => {
    expect(() => resolveBrowserObserveMaxElements(Number.NaN)).toThrow('有限数字')
    expect(() => resolveBrowserObserveMaxElements(Number.POSITIVE_INFINITY)).toThrow('有限数字')
  })
})

describe('isInteractiveAxRole', () => {
  test('given an interactive role then true; given a passive role then false', () => {
    expect(isInteractiveAxRole('button')).toBe(true)
    expect(isInteractiveAxRole('link')).toBe(true)
    expect(isInteractiveAxRole('textbox')).toBe(true)
    expect(isInteractiveAxRole('paragraph')).toBe(false)
    expect(isInteractiveAxRole('heading')).toBe(false)
  })

  test('role matching is case-insensitive', () => {
    expect(isInteractiveAxRole('BUTTON')).toBe(true)
    expect(isInteractiveAxRole('TextBox')).toBe(true)
  })
})

describe('isInteractiveCandidate', () => {
  test('given an interactive role then true even without editable', () => {
    expect(isInteractiveCandidate({ role: 'button' })).toBe(true)
  })

  test('given a non-interactive role but editable then true', () => {
    expect(isInteractiveCandidate({ role: 'paragraph', editable: true })).toBe(true)
  })

  test('given a passive role and non-editable then false', () => {
    expect(isInteractiveCandidate({ role: 'paragraph', editable: false })).toBe(false)
  })
})

describe('prioritizeBrowserObservationCandidates', () => {
  test('given interactive + context candidates then interactive ones are kept first, then context fills remaining budget', () => {
    const candidates = [
      candidate('paragraph', '上下文1'),
      candidate('button', '按钮'),
      candidate('link', '链接'),
      candidate('heading', '标题'),
    ]
    const selected = prioritizeBrowserObservationCandidates(candidates, 4)
    expect(selected.map((c) => c.role)).toEqual(['button', 'link', 'paragraph', 'heading'])
    // 预算 4：ceil(4*2/3)=3 个交互位，其中 2 个可交互都被保留；剩余 2 个上下文位填满
  })

  test('given only interactive candidates then the count respects the interactive budget (2/3 of max)', () => {
    const candidates = [
      candidate('button', 'a'),
      candidate('button', 'b'),
      candidate('button', 'c'),
      candidate('link', 'd'),
      candidate('link', 'e'),
      candidate('button', 'f'),
    ]
    const selected = prioritizeBrowserObservationCandidates(candidates, 5)
    // 交互预算 ceil(5*2/3) = 4；所有候选都是交互的，所以只保留前 4 个。
    expect(selected).toHaveLength(4)
    expect(selected.every((c) => isInteractiveCandidate(c))).toBe(true)
  })

  test('given mixed candidates then context fills what interactive leaves over', () => {
    const candidates = [
      candidate('heading', 'h'),
      candidate('listitem', 'li'),
      candidate('article', 'p'),
    ]
    const selected = prioritizeBrowserObservationCandidates(candidates, 10)
    expect(selected).toHaveLength(3)
  })
})

describe('browserObservationNameLimit', () => {
  test('interactive roles keep a longer name than passive roles', () => {
    expect(browserObservationNameLimit('button')).toBe(160)
    expect(browserObservationNameLimit('paragraph')).toBe(80)
  })
})
