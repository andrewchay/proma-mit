/**
 * Owner 运行验证的内置断言模板。
 *
 * 职责：提供系统自带的浏览器断言脚本，供受管浏览器在只读打开工作区 HTML 后执行。
 * 边界：
 * - 脚本由应用内置并随版本发布，模型不能生成或修改断言，避免"自己写出必然通过的自测"；
 * - 脚本只做读取与键盘事件模拟，不发起网络请求、不写入工作区文件；
 * - 目标结构不存在时返回 skipped 而不是 failed，skipped 不等于通过。
 */

export interface OwnerRuntimeAssertionTemplate {
  /** 稳定的断言标识，进入证据 checks[].id */
  id: string
  title: string
  /** 检查意图关键词：Owner 在方案里描述需求时用于匹配 */
  intentKeywords: readonly string[]
  /**
   * 在页面上下文执行的脚本表达式，必须求值为 { passed: boolean; skipped?: boolean; detail: string }。
   * 使用立即执行函数，避免污染页面作用域。
   */
  script: string
}

/** 键盘事件模拟用的通用片段：向 document 与 window 同时派发，兼容监听在任一处实现。 */
const KEY_HELPER = `
  const press = (key) => {
    for (const target of [document, window]) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true }))
      target.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }))
    }
  }
`

export const OWNER_RUNTIME_ASSERTION_TEMPLATES: readonly OwnerRuntimeAssertionTemplate[] = [
  {
    id: 'html.loads',
    title: '页面可加载且无脚本错误',
    intentKeywords: ['加载', '打开', '渲染', '页面', 'html'],
    script: `(() => {
      if (!document.body) return { passed: false, detail: '没有 body 元素' }
      const errors = window.__ownerAssertionErrors || []
      if (errors.length > 0) return { passed: false, detail: '脚本错误：' + String(errors[0]).slice(0, 200) }
      return { passed: true, detail: 'body 存在且有 ' + document.body.querySelectorAll('*').length + ' 个元素' }
    })()`,
  },
  {
    id: 'dom.board',
    title: '存在 16 格棋盘容器',
    intentKeywords: ['棋盘', '网格', '格子', 'board'],
    script: `(() => {
      const candidates = [...document.querySelectorAll('*')].filter((element) => {
        const style = getComputedStyle(element)
        return (style.display === 'grid' || style.display === 'inline-grid') && element.children.length >= 16
      })
      if (candidates.length === 0) return { passed: false, detail: '没有找到 16 格的网格容器' }
      const cells = candidates[0].children.length
      return { passed: cells === 16, detail: '网格子元素数量：' + cells }
    })()`,
  },
  {
    id: 'dom.initial-tiles',
    title: '开局至少两个数字块',
    intentKeywords: ['开局', '初始', '数字块', '方块'],
    script: `(() => {
      const numbers = [...document.querySelectorAll('*')]
        .filter((element) => element.children.length === 0)
        .map((element) => (element.textContent || '').trim())
        .filter((text) => /^[0-9]+$/.test(text))
      const tiles = numbers.filter((text) => Number(text) > 0)
      return { passed: tiles.length >= 2, detail: '数字块数量：' + tiles.length }
    })()`,
  },
  {
    id: 'behavior.merge',
    title: '同向按键可合并并计分',
    intentKeywords: ['合并', '计分', '得分', '键盘', '方向键', '操作'],
    script: `(() => {
      // 必须转换成数字：后续按数值判断"翻倍合并"，字符串会让查表恒为 -1。
      const readTiles = () => [...document.querySelectorAll('*')]
        .filter((element) => element.children.length === 0)
        .map((element) => Number((element.textContent || '').trim()))
        .filter((value) => Number.isInteger(value) && value > 0)
      const readScore = () => {
        const match = (document.body.innerText || '').match(/(?:分数|得分|score)[^0-9]{0,10}([0-9]+)/i)
        return match ? Number(match[1]) : null
      }
      if (readTiles().length === 0) return { passed: false, detail: '按键前没有读到数字块' }
      ${KEY_HELPER}
      // 合并判定用"数值翻倍的多重集"：某值出现至少两次，按键后该值减少且它的两倍出现。
      // 不能用"块数减少"——真实 2048 合并后会立即生成新块，块数往往不变；
      // 也不能只看分数增长——页面只要在按键时把分数文本加一就能伪造。
      const count = (values, target) => values.filter(value => value === target).length
      const mergedOnce = (before, after) => [...new Set(before)].some(value => count(before, value) >= 2
        && after.indexOf(value * 2) >= 0 && count(after, value) < count(before, value))
      let merged = false
      const tried = []
      for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const tilesBefore = readTiles()
          press(key)
          const tilesAfter = readTiles()
          tried.push(key + '：' + tilesBefore.join(',') + ' → ' + tilesAfter.join(','))
          if (mergedOnce(tilesBefore, tilesAfter)) { merged = true; break }
        }
        if (merged) break
      }
      if (!merged) return { passed: false, detail: '四个方向尝试后仍未观察到数值翻倍的合并产物：' + tried.join(' | ') }
      return { passed: true, detail: '出现翻倍合并产物；' + tried.join(' | ') }
    })()`,
  },
  {
    id: 'storage.best-score',
    title: '最高分可持久化',
    intentKeywords: ['最高分', '存档', '持久化', '记录'],
    script: `(() => {
      const entries = []
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index)
          entries.push([key, localStorage.getItem(key)])
        }
      } catch (error) { return { passed: false, detail: 'localStorage 不可用' } }
      if (entries.length === 0) return { passed: false, detail: '没有写入任何 localStorage 键，最高分未持久化' }
      // 任意键存在不代表最高分被保存：必须找到分数类键且值为数字。
      const scores = entries.filter(([key, value]) => /best|high|score|record|最高|纪录/i.test(String(key)) && /^[0-9]+$/.test(String(value ?? '').trim()))
      if (scores.length === 0) return { passed: false, detail: '没有最高分类键值；现有键：' + entries.slice(0, 5).map(([key]) => String(key)).join(', ') }
      return { passed: true, detail: '最高分键：' + scores.map(([key, value]) => key + '=' + value).join(', ') }
    })()`,
  },
  {
    id: 'dom.restart',
    title: '存在重开入口',
    intentKeywords: ['重开', '重置', '重新开始', '再来一局'],
    script: `(() => {
      const text = (document.body.innerText || '').toLowerCase()
      const keywords = ['重新开始', '重开', '再来一局', 'restart', 'reset', 'new game']
      const hit = keywords.find((keyword) => text.includes(keyword))
      if (hit) return { passed: true, detail: '界面包含重开入口：' + hit }
      const button = [...document.querySelectorAll('button')]
        .find((element) => /重|restart|reset|new/i.test(element.textContent || ''))
      return button ? { passed: true, detail: '找到重开按钮' } : { passed: false, detail: '未找到重开入口' }
    })()`,
  },
]

/** 未声明意图或意图无法识别时使用的默认子集：先证明页面真的跑起来了。 */
const DEFAULT_ASSERTION_IDS = ['html.loads', 'dom.board', 'dom.initial-tiles']

/**
 * 按 Owner 声明的检查意图选择断言模板。
 *
 * 规则：意图命中任一关键词即纳入；去重且保持注册顺序；全部未命中时退回默认子集，
 * 避免"意图写不清楚就什么都验证不了"。
 */
export function selectOwnerRuntimeAssertionTemplates(intents: readonly string[]): OwnerRuntimeAssertionTemplate[] {
  const text = intents.join(' ').toLowerCase()
  const matched = text
    ? OWNER_RUNTIME_ASSERTION_TEMPLATES.filter(template => template.intentKeywords.some(keyword => text.includes(keyword.toLowerCase())))
    : []
  const selected = matched.length > 0
    ? matched
    : OWNER_RUNTIME_ASSERTION_TEMPLATES.filter(template => DEFAULT_ASSERTION_IDS.includes(template.id))
  return [...selected]
}

/** 按稳定标识精确取模板；未知标识必须报错，不能静默忽略（否则"验证过"名不副实）。 */
export function resolveOwnerRuntimeAssertionTemplates(ids: readonly string[]): OwnerRuntimeAssertionTemplate[] {
  return ids.map((id) => {
    const template = OWNER_RUNTIME_ASSERTION_TEMPLATES.find(item => item.id === id)
    if (!template) throw new Error(`未知的运行验证断言标识：${id}`)
    return template
  })
}
