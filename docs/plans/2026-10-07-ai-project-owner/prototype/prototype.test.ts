import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const script = /<script>\s*([\s\S]*?)<\/script>/.exec(html)?.[1]
if (!script) throw new Error('原型缺少脚本')

interface DemoState {
  phase: string
  progress: number
  planVersion: number
  deliveryVersion: number
  grantVersion: number | null
  reworked: boolean
  events: string[]
}

/** 只模拟本原型使用的 DOM 与计时器；不替代受管浏览器视觉/交互走查。 */
function demo(kind = 'project', scenario = 'normal') {
  const elements = new Map<string, DemoElement>()
  const pending = new Map<number, () => void>()
  let ordinal = 0
  let renderedIds: string[] = []
  const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity] ?? entity)
  class DemoElement {
    value = ''
    textContent = ''
    private markup = ''
    private listeners = new Map<string, () => void>()
    constructor(readonly id: string) {}
    addEventListener(event: string, listener: () => void) { this.listeners.set(event, listener) }
    fire(event: string) {
      const listener = this.listeners.get(event)
      if (!listener) throw new Error(`当前界面无 ${this.id} 的 ${event} 交互`)
      listener()
    }
    get innerHTML() { return this.markup }
    set innerHTML(value: string) {
      this.markup = value
      if (this.id !== 'content') return
      for (const id of renderedIds) elements.delete(id)
      renderedIds = []
      for (const match of value.matchAll(/<(input|textarea|button|div)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const element = new DemoElement(match[2]!)
        element.value = decode(/\bvalue="([^"]*)"/.exec(match[0])?.[1] ?? '')
        if (match[1] === 'textarea') element.value = decode(value.slice(match.index! + match[0].length).split('</textarea>')[0] ?? '')
        elements.set(element.id, element)
        renderedIds.push(element.id)
      }
    }
  }
  for (const id of ['example', 'scenario', 'reset', 'project-title', 'content', 'sidebar']) elements.set(id, new DemoElement(id))
  elements.get('example')!.value = kind
  elements.get('scenario')!.value = scenario
  const context = createContext({
    document: { querySelector: (selector: string) => elements.get(selector.slice(1)) ?? null },
    setTimeout: (callback: () => void) => { pending.set(++ordinal, callback); return ordinal },
    clearTimeout: (id: number) => pending.delete(id),
  })
  runInContext(script!, context)
  return {
    get state(): DemoState { return runInContext('state', context) as DemoState },
    get content() { return elements.get('content')!.innerHTML },
    fill(id: string, value: string) { const element = elements.get(id); if (!element) throw new Error(`无输入 ${id}`); element.value = value },
    click(id: string) { const element = elements.get(id); if (!element) throw new Error(`当前界面无按钮 ${id}`); element.fire('click') },
    flush() {
      for (let i = 0; pending.size && i < 20; i++) {
        const entry = pending.entries().next().value
        if (!entry) return
        pending.delete(entry[0]); entry[1]()
      }
      if (pending.size) throw new Error('模拟出现不收敛计时器')
    },
    start() { this.click('propose'); this.click('confirm-plan'); this.click('authorize') },
  }
}

describe('AI Owner 离线原型交互（非产品 Runtime 验收）', () => {
  test('目标可先提出计划，确认计划本身不授权或自动运行', () => {
    const ui = demo(); ui.click('propose')
    expect(ui.state.phase).toBe('plan'); expect(ui.state.grantVersion).toBeNull()
    ui.click('confirm-plan'); ui.flush()
    expect(ui.state.phase).toBe('authorize'); expect(ui.state.progress).toBe(0)
  })
  test('空目标不进入固定示例计划', () => {
    const ui = demo(); ui.fill('objective', ' '); ui.click('propose')
    expect(ui.state.phase).toBe('goal')
  })
  test('缺信息时仅询问必要判断，答复后继续提出计划', () => {
    const ui = demo('project', 'clarify'); ui.click('propose')
    expect(ui.state.phase).toBe('clarify'); ui.fill('answer', ''); ui.click('answer')
    expect(ui.state.phase).toBe('clarify'); ui.fill('answer', '仅用于内部'); ui.click('answer')
    expect(ui.state.phase).toBe('plan'); expect(ui.content).toContain('仅用于内部')
  })
  test('调整计划产生新版本，不静默保留执行授权', () => {
    const ui = demo(); ui.click('propose'); ui.fill('plan-feedback', '加一项比较标准'); ui.click('revise')
    expect(ui.state.planVersion).toBe(2); expect(ui.state.grantVersion).toBeNull()
    expect(ui.content).toContain('加一项比较标准')
  })
  test('正常范围内三步自动推进，无逐任务点击', () => {
    const ui = demo(); ui.start(); ui.flush()
    expect(ui.state.phase).toBe('review'); expect(ui.state.progress).toBe(3)
    expect(ui.state.events).toHaveLength(7)
  })
  test('技术评审返工形成新成果版本并自动再审', () => {
    const ui = demo('project', 'rework'); ui.start(); ui.flush()
    expect(ui.state.phase).toBe('review'); expect(ui.state.deliveryVersion).toBe(2)
    expect(ui.state.reworked).toBe(true)
  })
  test('超范围先停等；保留原范围答复后自动继续', () => {
    const ui = demo('project', 'scope'); ui.start(); ui.flush()
    expect(ui.state.phase).toBe('scope'); expect(ui.state.progress).toBe(1)
    ui.click('keep-scope'); ui.flush(); expect(ui.state.phase).toBe('review')
  })
  test('范围扩展使旧授权失效，展示新增范围并重新确认', () => {
    const ui = demo('project', 'scope'); ui.start(); ui.flush(); ui.click('expand-scope')
    expect(ui.state.phase).toBe('plan'); expect(ui.state.planVersion).toBe(2)
    expect(ui.state.grantVersion).toBeNull(); ui.flush(); expect(ui.state.progress).toBe(0)
    ui.click('confirm-plan'); expect(ui.content).toContain('拟新增：外部访谈')
    ui.click('authorize'); ui.flush(); expect(ui.state.phase).toBe('review')
  })
  test('拒绝范围建议不自动续跑，保留动态', () => {
    const ui = demo('task', 'scope'); ui.start(); ui.flush(); ui.click('deny-scope'); ui.flush()
    expect(ui.state.phase).toBe('paused'); expect(ui.state.progress).toBe(1)
  })
  test('暂停取消计时器，显式恢复后才推进', () => {
    const ui = demo(); ui.start(); ui.click('pause'); ui.flush()
    expect(ui.state.progress).toBe(0); expect(ui.state.phase).toBe('paused')
    ui.click('resume'); ui.flush(); expect(ui.state.phase).toBe('review')
  })
  test('异常关闭只关闭管理事项，不清未知证据或预留', () => {
    const ui = demo('project', 'failure'); ui.start(); ui.flush()
    expect(ui.state.phase).toBe('failure'); ui.click('close-failure'); ui.flush()
    expect(ui.state.phase).toBe('closed'); expect(ui.content).toContain('unknown')
    expect(ui.content).toContain('原预算预留与已有证据保留')
  })
  test('代码成果验收与原仓库应用分离，可以取消应用', () => {
    const ui = demo('task'); ui.start(); ui.flush(); ui.click('accept')
    expect(ui.state.phase).toBe('accepted'); ui.click('apply'); expect(ui.state.phase).toBe('apply')
    ui.click('cancel-apply'); expect(ui.state.phase).toBe('accepted')
    ui.click('apply'); ui.click('confirm-apply'); expect(ui.state.phase).toBe('applied')
    expect(ui.content).toContain('原仓库没有任何写入')
  })
  test('业务修改意见用剩余返工额度，再次要求修改需新计划授权', () => {
    const ui = demo(); ui.start(); ui.flush(); ui.fill('review-feedback', '补充备选'); ui.click('request-rework'); ui.flush()
    expect(ui.state.phase).toBe('review'); expect(ui.state.deliveryVersion).toBe(2)
    ui.fill('review-feedback', '进一步调整'); ui.click('request-rework'); ui.flush()
    expect(ui.state.phase).toBe('plan'); expect(ui.state.grantVersion).toBeNull()
  })
  test('用户输入以文本转义展示，不插入可执行 HTML', () => {
    const ui = demo(); ui.fill('objective', '<img src=x onerror=alert(1)>'); ui.click('propose')
    expect(ui.content).toContain('&lt;img'); expect(ui.content).not.toContain('<img src=x')
  })
  test('原型没有模型/网络/权威项目或持久化调用', () => {
    expect(script).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|electronAPI|localStorage|sessionStorage|WebSocket/)
    expect(html).not.toMatch(/<script[^>]*src=|<link[^>]*href=["']https?:/)
  })
})
