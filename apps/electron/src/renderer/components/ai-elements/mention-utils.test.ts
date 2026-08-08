import { describe, expect, test } from 'bun:test'
import {
  findTriggerTokenStart,
  isTriggerInsideEmail,
  isTriggerInsideSchemeUrl,
  resolveTriggerContext,
  shouldAllowMentionTrigger,
  shouldSuppressAmpTrigger,
  shouldSuppressHashTrigger,
  shouldTriggerOnUiEvent,
} from './mention-utils'

function offsetOf(text: string, char: string): number {
  const idx = text.indexOf(char)
  if (idx === -1) throw new Error(`cannot find '${char}' in test text: ${text}`)
  // 测试按单个触发符定位：取该字符首次出现的下标。
  return idx
}

describe('findTriggerTokenStart', () => {
  test('given trigger in middle of word then returns word start', () => {
    expect(findTriggerTokenStart('print @foo here', 7)).toBe(6)
  })

  test('given trigger at token start then returns same index', () => {
    expect(findTriggerTokenStart('print @foo', 6)).toBe(6)
  })

  test('given out-of-range offset then returns -1', () => {
    expect(findTriggerTokenStart('ab', 5)).toBe(-1)
  })
})

describe('isTriggerInsideSchemeUrl', () => {
  test('given trigger after scheme:// then suppresses', () => {
    const text = 'see https://foo#bar'
    expect(isTriggerInsideSchemeUrl(text, offsetOf(text, '#'))).toBe(true)
  })

  test('given plain @/path not inside scheme then allows', () => {
    const text = 'open @/tmp/x'
    expect(isTriggerInsideSchemeUrl(text, offsetOf(text, '@'))).toBe(false)
  })
})

describe('isTriggerInsideEmail', () => {
  test('given @ inside email then suppresses', () => {
    const text = 'mail me@example.com now'
    expect(isTriggerInsideEmail(text, offsetOf(text, '@'))).toBe(true)
  })

  test('given @ at token start (not email) then allows', () => {
    const text = 'quote @todo now'
    expect(isTriggerInsideEmail(text, offsetOf(text, '@'))).toBe(false)
  })
})

describe('shouldSuppressHashTrigger', () => {
  test('given markdown heading at line start then suppresses', () => {
    expect(shouldSuppressHashTrigger({ paragraphText: '## 标题', triggerOffset: offsetOf('## 标题', '#'), trigger: '#' })).toBe(true)
  })

  test('given issue number #123 then suppresses', () => {
    const t = 'see #123'
    expect(shouldSuppressHashTrigger({ paragraphText: t, triggerOffset: offsetOf(t, '#'), trigger: '#' })).toBe(true)
  })

  test('given hex color then suppresses', () => {
    const t = 'use #ff6600'
    expect(shouldSuppressHashTrigger({ paragraphText: t, triggerOffset: offsetOf(t, '#'), trigger: '#' })).toBe(true)
  })

  test('given normal mcp mention #myServer then allows', () => {
    const t = 'use #myServer'
    expect(shouldSuppressHashTrigger({ paragraphText: t, triggerOffset: offsetOf(t, '#'), trigger: '#' })).toBe(false)
  })
})

describe('shouldSuppressAmpTrigger', () => {
  test('given && then suppresses', () => {
    const t = 'a && b'
    expect(shouldSuppressAmpTrigger({ paragraphText: t, triggerOffset: 3, trigger: '&' })).toBe(true)
  })

  test('given html entity &amp; then suppresses', () => {
    const t = 'Tom &amp; Jerry'
    expect(shouldSuppressAmpTrigger({ paragraphText: t, triggerOffset: offsetOf(t, '&'), trigger: '&' })).toBe(true)
  })

  test('given normal session mention &ai then allows', () => {
    const t = 'attach &ai'
    expect(shouldSuppressAmpTrigger({ paragraphText: t, triggerOffset: offsetOf(t, '&'), trigger: '&' })).toBe(false)
  })
})

describe('shouldAllowMentionTrigger', () => {
  test('given @ inside email then suppresses file mention', () => {
    const text = 'contact dev@gravity.io'
    expect(shouldAllowMentionTrigger({ paragraphText: text, triggerOffset: offsetOf(text, '@'), trigger: '@' })).toBe(false)
  })

  test('given npm scope @org/pkg then suppresses', () => {
    const text = 'dep @scope/com'
    expect(shouldAllowMentionTrigger({ paragraphText: text, triggerOffset: offsetOf(text, '@'), trigger: '@' })).toBe(false)
  })

  test('given normal @file then allows', () => {
    const text = 'read @readme'
    expect(shouldAllowMentionTrigger({ paragraphText: text, triggerOffset: offsetOf(text, '@'), trigger: '@' })).toBe(true)
  })

  test('given # inside url then suppresses', () => {
    const text = 'go to https://x.y/z#section'
    expect(shouldAllowMentionTrigger({ paragraphText: text, triggerOffset: offsetOf(text, '#'), trigger: '#' })).toBe(false)
  })
})

describe('shouldTriggerOnUiEvent', () => {
  test('given paste then suppresses', () => {
    expect(shouldTriggerOnUiEvent('paste')).toBe(false)
  })

  test('given drop then suppresses', () => {
    expect(shouldTriggerOnUiEvent('drop')).toBe(false)
  })

  test('given typing / undefined then allows', () => {
    expect(shouldTriggerOnUiEvent(undefined)).toBe(true)
    expect(shouldTriggerOnUiEvent('input')).toBe(true)
  })
})

describe('resolveTriggerContext', () => {
  const { Schema } = require('@tiptap/pm/model')
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
      text: { group: 'inline' },
    },
  })
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second #123' }] }],
  })

  test('given trigger in paragraph then returns its text and inner offset', () => {
    // 单段落文档：doc 起始位 = 块分隔 1，文本从位置 1 起。
    const hashAbs = 1 + 'second '.length
    const ctx = resolveTriggerContext(doc, hashAbs)
    expect(ctx).not.toBeNull()
    expect(ctx!.paragraphText).toBe('second #123')
    expect(ctx!.triggerOffset).toBe('second '.length)
    // 组合起来应命中 '#' 抑制规则（# 后是 issue 编号）。
    const allowed = shouldAllowMentionTrigger({ paragraphText: ctx!.paragraphText, triggerOffset: ctx!.triggerOffset, trigger: '#' })
    expect(allowed).toBe(false)
  })
})
