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

/** 从 document 冒泡到 window，一次按键只派发一次，避免重复移动。 */
const KEY_HELPER = `
  const press = (key) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }))
  }
`

/** 只数参与网格布局的格子；隐藏元素及绝对定位遮罩不占棋盘格。 */
const BOARD_HELPER = `
  const gridCells = element => [...element.children].filter(cell => {
    const style = getComputedStyle(cell)
    return style.display !== 'none' && style.visibility !== 'hidden' && !['absolute', 'fixed'].includes(style.position)
  })
  const board = [...document.querySelectorAll('*')].find(element => {
    const display = getComputedStyle(element).display
    return (display === 'grid' || display === 'inline-grid') && gridCells(element).length === 16
  })
  const readBoard = () => board ? gridCells(board).map(cell => Number((cell.textContent || '').trim()) || 0) : []
  const readTiles = () => readBoard().filter(value => value > 0)
`

/**
 * 三消断言共用：8×8 棋盘、棋子签名（忽略选中/动画等状态类）、稳定等待、点击模拟与交换求解。
 * 棋子签名只取结构性特征（子元素标签、去状态类后的 class、填充/背景色或文字），
 * 让消除、下落、选中高亮等过渡态不改变签名语义；动画期间一律先等棋盘稳定再读写。
 */
const MATCH3_HELPER = `
  const gridCells = element => [...element.children].filter(cell => {
    const style = getComputedStyle(cell)
    return style.display !== 'none' && style.visibility !== 'hidden' && !['absolute', 'fixed'].includes(style.position)
  })
  const findBoard = () => [...document.querySelectorAll('*')].find(element => {
    const display = getComputedStyle(element).display
    return (display === 'grid' || display === 'inline-grid') && gridCells(element).length === 64
  })
  let board = findBoard()
  const STATE_CLASSES = new Set(['selected', 'active', 'hover', 'focus', 'focused', 'drag', 'dragging', 'swap', 'swapping', 'moving', 'falling', 'fall', 'drop', 'dropping', 'matched', 'matching', 'pop', 'popping', 'clear', 'clearing', 'hint', 'hinted', 'shake', 'shaking'])
  const sig = (cell) => {
    const kid = cell.firstElementChild
    if (kid) {
      const raw = kid.className && kid.className.baseVal !== undefined ? kid.className.baseVal : String(kid.className || '')
      const cls = raw.split(/\\s+/).filter(name => name && !STATE_CLASSES.has(name.toLowerCase())).sort().join('.')
      const style = getComputedStyle(kid)
      const fill = style.fill && style.fill !== 'none' ? style.fill : ''
      return kid.tagName + '|' + cls + '|' + (fill || style.backgroundColor)
    }
    const text = (cell.textContent || '').trim()
    if (text) return 'text|' + text
    return 'bg|' + getComputedStyle(cell).backgroundColor
  }
  const cells = () => gridCells(board)
  const pieces = () => cells().map(sig)
  const boardSig = () => pieces().join(';')
  const isEmptySig = value => /^bg\\|(rgba\\(0, 0, 0, 0\\)|transparent)$/.test(value)
  const settle = async () => {
    let last = boardSig(), stable = 0
    for (let round = 0; round < 30 && stable < 3; round += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      const current = boardSig()
      stable = current === last ? stable + 1 : 0
      last = current
    }
    return last
  }
  const tap = (cell) => {
    const rect = cell.getBoundingClientRect()
    const init = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      cell.dispatchEvent(type.startsWith('pointer') && typeof PointerEvent === 'function' ? new PointerEvent(type, init) : new MouseEvent(type, init))
    }
  }
  const matchAt = (grid, index) => {
    const row = Math.floor(index / 8), col = index % 8, value = grid[index]
    let run = 1
    for (let c = col - 1; c >= 0 && grid[row * 8 + c] === value; c -= 1) run += 1
    for (let c = col + 1; c < 8 && grid[row * 8 + c] === value; c += 1) run += 1
    if (run >= 3) return true
    run = 1
    for (let r = row - 1; r >= 0 && grid[r * 8 + col] === value; r -= 1) run += 1
    for (let r = row + 1; r < 8 && grid[r * 8 + col] === value; r += 1) run += 1
    return run >= 3
  }
  const hasMatch = grid => grid.some((_, index) => matchAt(grid, index))
  // 只比较交换两格是否形成新三连；已存在的三连由调用方先排除，避免误判。
  const findSwap = (grid, wantMatch) => {
    for (let index = 0; index < 64; index += 1) {
      const row = Math.floor(index / 8), col = index % 8
      const neighbors = []
      if (col < 7) neighbors.push(index + 1)
      if (row < 7) neighbors.push(index + 8)
      for (const other of neighbors) {
        if (grid[index] === grid[other]) continue
        const next = grid.slice()
        next[index] = grid[other]
        next[other] = grid[index]
        if ((matchAt(next, index) || matchAt(next, other)) === wantMatch) return [index, other]
      }
    }
    return null
  }
  const readScore = () => {
    const match = (document.body.innerText || '').match(/(?:分数|得分|score)[^0-9]{0,10}([0-9]+)/i)
    return match ? Number(match[1]) : null
  }
  const readMoves = () => {
    const match = (document.body.innerText || '').match(/(?:剩余步数|步数|moves(?:\\s*left)?)[^0-9]{0,10}([0-9]+)/i)
    return match ? Number(match[1]) : null
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
      ${BOARD_HELPER}
      return { passed: Boolean(board), detail: board ? '参与网格布局的棋盘格数量：16' : '没有找到恰好16格的网格容器' }
    })()`,
  },
  {
    id: 'dom.initial-tiles',
    title: '开局至少两个数字块',
    intentKeywords: ['开局', '初始', '数字块', '方块'],
    script: `(() => {
      ${BOARD_HELPER}
      const tiles = readTiles()
      return { passed: tiles.length >= 2, detail: '数字块数量：' + tiles.length }
    })()`,
  },
  {
    id: 'behavior.merge',
    title: '同向按键可合并并计分',
    intentKeywords: ['合并', '计分', '得分', '键盘', '方向键', '操作'],
    script: `(() => {
      // 必须转换成数字：后续按数值判断"翻倍合并"，字符串会让查表恒为 -1。
      ${BOARD_HELPER}
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
          const scoreBefore = readScore()
          press(key)
          const tilesAfter = readTiles()
          tried.push(key + '：' + tilesBefore.join(',') + ' → ' + tilesAfter.join(','))
          if (mergedOnce(tilesBefore, tilesAfter) && scoreBefore !== null && readScore() > scoreBefore) { merged = true; break }
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
      const scores = entries.filter(([key, value]) => /best|high/i.test(String(key)) && /^[0-9]+$/.test(String(value ?? '').trim()))
      if (scores.length === 0) return { passed: false, detail: '没有最高分类键值；现有键：' + entries.slice(0, 5).map(([key]) => String(key)).join(', ') }
      const shown = (document.body.innerText || '').match(/(?:最高分|best(?:\\s*score)?|high(?:\\s*score)?)[^0-9]{0,10}([0-9]+)/i)
      const score = (document.body.innerText || '').match(/(?:分数|得分|score)[^0-9]{0,10}([0-9]+)/i)
      const matching = shown ? scores.filter(([, value]) => Number(value) === Number(shown[1])) : []
      if (!matching.length || !score || Number(shown[1]) < Number(score[1])) return { passed: false, detail: '存储最高分与界面或本局得分不一致' }
      return { passed: true, bestScore: JSON.stringify(matching), detail: '界面最高分与存储一致：' + shown[1] }
    })()`,
  },
  {
    id: 'behavior.game-over',
    title: '无法移动时显示游戏结束',
    intentKeywords: ['游戏结束', '结束判定', 'game over'],
    script: `(() => {
      ${BOARD_HELPER}
      if (!board) return { passed: false, detail: '没有16格棋盘，无法检查结束条件' }
      const read = readBoard
      const isOver = values => values.length === 16 && values.every(value => value > 0) && values.every((value, index) =>
        (index % 4 === 3 || value !== values[index + 1]) && (index >= 12 || value !== values[index + 4]))
      ${KEY_HELPER}
      // 固定按键序列只操作页面，不读取或修改游戏内部变量；达到真实死局后核对提示。
      const keys = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowDown', 'ArrowRight']
      for (let move = 0; move < 3000; move += 1) {
        if (isOver(read())) {
          const visible = [...document.querySelectorAll('*')].some(element =>
            element.children.length === 0 && /游戏结束|game\\s*over|无路可走|无法移动/i.test(element.textContent || '')
            && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
          return { passed: visible, detail: visible ? '实际棋盘无空格及可合并相邻块，已显示结束提示' : '已形成无法移动的棋盘，但没有可见结束提示' }
        }
        press(keys[move % keys.length])
      }
      return { passed: false, detail: '3000次按键内未形成可核验的结束状态，结束行为尚未证明' }
    })()`,
  },
  {
    id: 'dom.restart',
    title: '重新开始恢复开局与零分',
    intentKeywords: ['重开', '重置', '重新开始', '再来一局'],
    script: `(() => {
      const button = [...document.querySelectorAll('button, [role="button"]')]
        .find(element => /重新开始|重开|再来一局|restart|reset|new game/i.test(element.textContent || ''))
      if (!button) return { passed: false, detail: '未找到明确的重开按钮' }
      button.click()
      ${BOARD_HELPER}
      const tiles = readTiles().length
      const score = (document.body.innerText || '').match(/(?:分数|得分|score)[^0-9]{0,10}([0-9]+)/i)
      const passed = tiles === 2 && score !== null && Number(score[1]) === 0
      return { passed, detail: '点击重开后数字块=' + tiles + '，分数=' + (score ? score[1] : '不可读') }
    })()`,
  },
  {
    id: 'match3.board',
    title: '存在 8×8 满盘棋子棋盘',
    intentKeywords: ['三消', '棋子'],
    script: `(async () => {
      ${MATCH3_HELPER}
      if (!board) return { passed: false, skipped: true, detail: '没有找到恰好64格的网格容器' }
      await settle()
      const current = pieces()
      const empty = current.filter(isEmptySig).length
      const kinds = new Set(current.filter(value => !isEmptySig(value)))
      return { passed: kinds.size >= 4 && empty === 0, detail: '64格棋盘，棋子种类 ' + kinds.size + '，空格 ' + empty }
    })()`,
  },
  {
    id: 'match3.swap',
    title: '有效交换使棋盘变化',
    intentKeywords: ['交换', '三消'],
    script: `(async () => {
      ${MATCH3_HELPER}
      if (!board) return { passed: false, skipped: true, detail: '没有找到恰好64格的网格容器' }
      const before = await settle()
      const grid = before.split(';')
      if (hasMatch(grid)) return { passed: false, detail: '棋盘稳定后仍存在未消除的三连，无法核验交换' }
      const pair = findSwap(grid, true)
      if (!pair) return { passed: false, skipped: true, detail: '当前棋盘找不到可形成三连的交换' }
      tap(cells()[pair[0]])
      tap(cells()[pair[1]])
      const after = await settle()
      const passed = after !== before && cells().length === 64
      return { passed, detail: passed ? '有效交换后棋盘发生变化且仍为64格' : '交换后棋盘未变化或格子数异常（' + cells().length + '）' }
    })()`,
  },
  {
    id: 'match3.invalid-revert',
    title: '无效交换自动还原且不扣步数',
    intentKeywords: ['无效交换', '还原'],
    script: `(async () => {
      ${MATCH3_HELPER}
      if (!board) return { passed: false, skipped: true, detail: '没有找到恰好64格的网格容器' }
      const before = await settle()
      const grid = before.split(';')
      if (hasMatch(grid)) return { passed: false, detail: '棋盘稳定后仍存在未消除的三连，无法核验无效交换' }
      const pair = findSwap(grid, false)
      if (!pair) return { passed: false, skipped: true, detail: '当前棋盘任意相邻交换都会形成三连，无法核验无效交换还原' }
      const movesBefore = readMoves()
      tap(cells()[pair[0]])
      tap(cells()[pair[1]])
      const after = await settle()
      const reverted = after === before
      const movesAfter = readMoves()
      const movesKept = movesBefore === null || movesAfter === movesBefore
      return { passed: reverted && movesKept, detail: '无效交换后棋盘' + (reverted ? '已还原' : '未还原') + '；步数' + (movesBefore === null ? '不可读，未核验' : movesKept ? '未扣减' : '被错误扣减：' + movesBefore + '→' + movesAfter) }
    })()`,
  },
  {
    id: 'match3.score',
    title: '消除后计分且棋盘补满',
    intentKeywords: ['消除', '补满'],
    script: `(async () => {
      ${MATCH3_HELPER}
      if (!board) return { passed: false, skipped: true, detail: '没有找到恰好64格的网格容器' }
      const before = await settle()
      const grid = before.split(';')
      if (hasMatch(grid)) return { passed: false, detail: '棋盘稳定后仍存在未消除的三连，无法核验计分' }
      const pair = findSwap(grid, true)
      if (!pair) return { passed: false, skipped: true, detail: '当前棋盘找不到可形成三连的交换' }
      const scoreBefore = readScore()
      if (scoreBefore === null) return { passed: false, skipped: true, detail: '无法从页面读取分数，计分行为不可核验' }
      const movesBefore = readMoves()
      tap(cells()[pair[0]])
      tap(cells()[pair[1]])
      const after = await settle()
      const current = after.split(';')
      const scoreAfter = readScore()
      const gained = scoreAfter !== null && scoreAfter > scoreBefore
      const refilled = current.length === 64 && !current.some(isEmptySig)
      const movesAfter = readMoves()
      const movesOk = movesBefore === null || movesAfter === movesBefore - 1
      return { passed: gained && refilled && movesOk, detail: '分数 ' + scoreBefore + '→' + scoreAfter + '；消除后棋盘' + (refilled ? '已补满64格' : '未补满') + '；步数' + (movesBefore === null ? '不可读，未核验' : movesBefore + '→' + movesAfter) }
    })()`,
  },
  {
    id: 'match3.restart',
    title: '重开后棋盘满盘且分数归零',
    intentKeywords: ['满盘重开', '归零'],
    script: `(async () => {
      ${MATCH3_HELPER}
      if (!board) return { passed: false, skipped: true, detail: '没有找到恰好64格的网格容器' }
      const button = [...document.querySelectorAll('button, [role="button"]')]
        .find(element => /重新开始|重开|再来一局|restart|reset|new game/i.test(element.textContent || ''))
      if (!button) return { passed: false, skipped: true, detail: '未找到明确的重开按钮' }
      const scoreBefore = readScore()
      button.click()
      board = findBoard()
      if (!board) return { passed: false, detail: '重开后找不到64格棋盘' }
      await settle()
      const current = pieces()
      const full = current.length === 64 && !current.some(isEmptySig)
      const scoreAfter = readScore()
      const zeroed = scoreBefore === null ? scoreAfter === null || scoreAfter === 0 : scoreAfter === 0
      return { passed: full && zeroed, detail: '重开后棋盘' + (full ? '满盘64格' : '未满盘') + '；分数=' + (scoreAfter === null ? '不可读' : scoreAfter) }
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
