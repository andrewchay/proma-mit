import { expect, test } from 'bun:test'
import { parseDesignPreviewSelection } from './design-preview-selection'

test('Given 隔离画面选择消息 When 来源、版本令牌或字段不匹配 Then 拒绝', () => {
  const source = {} as Window
  const event = (value: unknown, sender: Window = source) => ({ source: sender, origin: 'null', data: value }) as MessageEvent
  const valid = { type: 'gravitas-design-selection', token: 'current', tag: 'h1', text: '标题' }
  expect(parseDesignPreviewSelection(event(valid), source, 'current')).toEqual({ tag: 'h1', text: '标题' })
  expect(parseDesignPreviewSelection(event(valid, {} as Window), source, 'current')).toBeNull()
  expect(parseDesignPreviewSelection(event(valid), source, 'other-version')).toBeNull()
  expect(parseDesignPreviewSelection(event({ ...valid, text: 'x'.repeat(301) }), source, 'current')).toBeNull()
  expect(parseDesignPreviewSelection(event({ ...valid, command: 'write' }), source, 'current')).toBeNull()
})
