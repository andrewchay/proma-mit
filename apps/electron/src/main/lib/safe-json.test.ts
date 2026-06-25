import { describe, test, expect } from 'bun:test'
import { safeParseJSON, safeParseJSONObject } from './safe-json'

describe('safeParseJSON', () => {
  test('解析合法 JSON 返回对应值', () => {
    expect(safeParseJSON('{"text":"hello"}', {})).toEqual({ text: 'hello' })
  })

  test('解析非法 JSON 返回 fallback', () => {
    expect(safeParseJSON('{invalid}', { text: '' })).toEqual({ text: '' })
  })

  test('传入空字符串返回 fallback', () => {
    expect(safeParseJSON('', { text: '' })).toEqual({ text: '' })
  })

  test('传入 null 返回 fallback', () => {
    expect(safeParseJSON(null as unknown as string, { text: '' })).toEqual({ text: '' })
  })
})

describe('safeParseJSONObject', () => {
  test('解析对象返回对象', () => {
    expect(safeParseJSONObject('{"a":1}')).toEqual({ a: 1 })
  })

  test('解析数组返回空对象', () => {
    expect(safeParseJSONObject('[1,2,3]')).toEqual({})
  })

  test('解析非法 JSON 返回空对象', () => {
    expect(safeParseJSONObject('{invalid}')).toEqual({})
  })

  test('解析 null 返回空对象', () => {
    expect(safeParseJSONObject('null')).toEqual({})
  })
})
