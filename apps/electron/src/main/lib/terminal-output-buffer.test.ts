import { describe, expect, test } from 'bun:test'
import { appendTerminalOutput } from './terminal-output-buffer'

describe('终端输出缓冲', () => {
  test('序号单调递增且只保留容量内的末尾', () => {
    const first = appendTerminalOutput({ output: '', sequence: 0 }, '1234', 6)
    expect(appendTerminalOutput(first, '5678', 6)).toEqual({ output: '345678', sequence: 2 })
  })

  test('拒绝无效容量', () => {
    expect(() => appendTerminalOutput({ output: '', sequence: 0 }, 'x', 0)).toThrow()
  })
})
