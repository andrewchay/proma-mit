import { describe, expect, test } from 'bun:test'
import { parseBrowserPressAction } from './browser-key-policy'

describe('parseBrowserPressAction', () => {
  test('given a navigation key then a key action with windowsVirtualKeyCode is returned', () => {
    const action = parseBrowserPressAction('Enter')
    expect(action.kind).toBe('key')
    if (action.kind === 'key') {
      expect(action.code).toBe('Enter')
      expect(action.windowsVirtualKeyCode).toBe(13)
    }
  })

  test('given PageDown then it carries the correct VK code so Chromium triggers default scrolling', () => {
    const action = parseBrowserPressAction('PageDown')
    if (action.kind === 'key') {
      expect(action.windowsVirtualKeyCode).toBe(34)
    }
  })

  test('given arrow keys then they are recognized as navigation', () => {
    expect(parseBrowserPressAction('ArrowUp').kind).toBe('key')
    expect(parseBrowserPressAction('ArrowDown').kind).toBe('key')
    expect(parseBrowserPressAction('ArrowLeft').kind).toBe('key')
    expect(parseBrowserPressAction('ArrowRight').kind).toBe('key')
  })

  test('given Space then it becomes a single-space text insertion', () => {
    const action = parseBrowserPressAction('Space')
    expect(action.kind).toBe('text')
    if (action.kind === 'text') expect(action.text).toBe(' ')
  })

  test('given plain text then a text action is returned', () => {
    const action = parseBrowserPressAction('hello')
    expect(action.kind).toBe('text')
    if (action.kind === 'text') expect(action.text).toBe('hello')
  })

  test('given text with unicode and newline then it is kept as-is for Input.insertText', () => {
    const text = '第一行\n第二行'
    const action = parseBrowserPressAction(text)
    if (action.kind === 'text') expect(action.text).toBe(text)
  })

  test('given an empty input then an error is thrown', () => {
    expect(() => parseBrowserPressAction('')).toThrow('需要导航键或非空文本')
  })

  test('given over-length text then an error is thrown', () => {
    expect(() => parseBrowserPressAction('x'.repeat(10_001))).toThrow('单次输入不能超过')
  })

  test('given unsupported control characters then an error is thrown', () => {
    expect(() => parseBrowserPressAction('a\u0007b')).toThrow('不支持的控制字符')
  })
})
