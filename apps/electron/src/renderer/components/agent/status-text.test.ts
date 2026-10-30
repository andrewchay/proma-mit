import { describe, expect, test } from 'bun:test'
import { hideStatusEmoji } from './status-text'

describe('回复中的状态标记', () => {
  test('保留正文文字和 Markdown，隐藏状态圆点', () => {
    expect(hideStatusEmoji('🟢**已完成**：A\n- 🔴 还差：B\n🟡 计划：next.md'))
      .toBe('**已完成**：A\n- 还差：B\n计划：next.md')
  })
  test('保留无关的圆点和原有文本', () => {
    expect(hideStatusEmoji('图例：🟢 正常\n🟢 苹果\n说明')).toBe('图例：🟢 正常\n🟢 苹果\n说明')
  })
})
