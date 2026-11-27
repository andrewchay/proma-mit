import { describe, expect, test } from 'bun:test'
import { OWNER_RUNTIME_ASSERTION_TEMPLATES, selectOwnerRuntimeAssertionTemplates } from './owner-runtime-assertion-templates'

describe('内置运行验证断言模板', () => {
  test('Given 模板注册表 When 检查 Then 标识唯一且脚本可执行', () => {
    const ids = OWNER_RUNTIME_ASSERTION_TEMPLATES.map(template => template.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const template of OWNER_RUNTIME_ASSERTION_TEMPLATES) {
      expect(template.title.trim().length).toBeGreaterThan(0)
      expect(template.intentKeywords.length === 0).toBe(['counter.increment-reset', 'counter.mouse-keyboard'].includes(template.id))
      // 脚本必须是可求值的表达式（此处只做语法构造检查，真实执行由受管浏览器负责）。
      expect(() => new Function(`return ${template.script}`)).not.toThrow()
    }
  })

  test('Given 合并计分意图 When 选择模板 Then 命中合并与计分断言', () => {
    const ids = selectOwnerRuntimeAssertionTemplates(['验证合并与计分']).map(template => template.id)
    expect(ids).toContain('behavior.merge')
    expect(ids).not.toContain('storage.best-score')
  })

  test('Given 多个意图 When 选择模板 Then 去重且保持注册顺序', () => {
    const ids = selectOwnerRuntimeAssertionTemplates(['页面可加载', '棋盘', '最大分数持久化']).map(template => template.id)
    expect(ids).toEqual([...new Set(ids)])
    expect(ids).toEqual(['html.loads', 'dom.board', 'storage.best-score'])
  })

  test('Given补测断言 When匹配一般意图 Then不会隐式增加计数器交互检查', () => {
    const ids = selectOwnerRuntimeAssertionTemplates(['计数器需要加一和重置']).map(template => template.id)
    expect(ids).not.toContain('counter.increment-reset')
    expect(ids).not.toContain('counter.mouse-keyboard')
  })

  test('Given 意图为空 When 选择模板 Then 退回默认子集而非空集', () => {
    expect(selectOwnerRuntimeAssertionTemplates([]).map(template => template.id)).toEqual(['html.loads', 'dom.board', 'dom.initial-tiles'])
  })

  test('Given 意图无法识别 When 选择模板 Then 仍退回默认子集', () => {
    expect(selectOwnerRuntimeAssertionTemplates(['随便看看这个作品']).map(template => template.id)).toEqual(['html.loads', 'dom.board', 'dom.initial-tiles'])
  })

  test('Given 三消意图 When 选择模板 Then 命中三消断言且不混入16格棋盘', () => {
    // 注意：意图里的“棋盘”一词仍会命中 2048 的 dom.board；真实安排路径由模型显式选择断言标识，不经意图匹配。
    const ids = selectOwnerRuntimeAssertionTemplates(['三消棋子可以交换并消除']).map(template => template.id)
    expect(ids).toContain('match3.board')
    expect(ids).toContain('match3.swap')
    expect(ids).toContain('match3.score')
    expect(ids).not.toContain('dom.board')
    expect(ids).not.toContain('behavior.merge')
  })

  test('Given 全部模板 When 检查脚本 Then 不发起网络请求也不写文件', () => {
    for (const template of OWNER_RUNTIME_ASSERTION_TEMPLATES) {
      expect(template.script).not.toMatch(/fetch\s*\(|XMLHttpRequest|WebSocket|node:fs|require\s*\(/)
    }
  })
})

test.each(['none', 'rad-cos', 'mixed'] as const)('Given科学计算器（缺陷=%s） When运行内置断言 Then实际检查两种单位的三角函数', async defect => {
  const template = OWNER_RUNTIME_ASSERTION_TEMPLATES.find(item => item.id === 'calculator.scientific')!
  const element = () => ({ disabled: false, getClientRects: () => [{}] })
  const result = { ...element(), textContent: '' }, error = { ...element(), textContent: '' }
  const input = { ...element(), value: '', readOnly: false, dispatchEvent() {} }
  const angle = { ...element(), value: 'deg', dispatchEvent() {}, options: [
    { value: 'deg', textContent: '角度', matches: () => false }, { value: 'rad', textContent: '弧度', matches: () => false },
  ] }
  const arithmetic: Record<string, number> = { '2+3*4': 14, '(2+3)*4-6/2': 17 }
  const calls: string[] = []
  const calculate = { ...element(), click() {
    calls.push(angle.value + ':' + input.value)
    const trig = /^(sin|cos)\(([\d.]+)\)$/.exec(input.value)
    if (input.value === '1/0') { error.textContent = '不能除以零'; result.textContent = ''; return }
    error.textContent = ''
    if (trig) {
      const angleValue = Number(trig[2]) * (angle.value === 'deg' ? Math.PI / 180 : 1)
      result.textContent = String(defect === 'rad-cos' && angle.value === 'rad' && trig[1] === 'cos'
        ? 1 : trig[1] === 'sin' ? Math.sin(angleValue) : Math.cos(angleValue))
    } else if (/^sin\([\d.]+\)[+-]cos\(0\)$/.test(input.value)) {
      result.textContent = defect === 'mixed' ? '' : input.value.includes('+') ? '2' : '0'
      if (defect === 'mixed') error.textContent = '表达式存在多余内容：u+'
    } else result.textContent = String(arithmetic[input.value])
  } }
  const clear = { ...element(), click() { input.value = result.textContent = error.textContent = '' } }
  const controls = { 'input#expression': input, 'select#angle': angle, 'button#calculate': calculate, 'button#clear': clear }
  const nodes = { result, error }
  const document = { querySelector: (key: keyof typeof controls) => controls[key], getElementById: (key: keyof typeof nodes) => nodes[key] }
  const run = new Function('document', 'getComputedStyle', 'setTimeout', 'Event', 'return ' + template.script)
  const outcome: { passed: boolean; detail: string } = await run(document, () => ({ visibility: 'visible' }), (callback: () => void) => callback(), Event)
  expect(calls).toContain('deg:sin(90)+cos(0)')
  if (defect !== 'mixed') {
    expect(calls).toContain('rad:sin(1.5707963267948966)')
    expect(calls).toContain('rad:cos(3.141592653589793)')
  }
  if (defect === 'none') expect(calls).toContain('rad:sin(1.5707963267948966)-cos(0)')
  expect(outcome.passed).toBe(defect === 'none')
  expect(outcome.detail).toContain({ none: '角度 deg', 'rad-cos': '弧度模式 cos(', mixed: '角度模式 sin(90)+cos(0)' }[defect])
})
