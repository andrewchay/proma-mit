/**
 * Schedule NLP - 自然语言日程解析
 *
 * 将自然语言描述解析为结构化的日程事件草案。
 * v0.1 使用本地规则引擎（正则 + 关键词），后续可接入 LLM API。
 *
 * 示例输入：
 * - "下周三下午2点客户过方案，2小时，会议室A"
 * - "明天上午10点团队周会"
 * - "每周一早上9点健身，持续4周"
 */

import type { ScheduleEventInput, RecurrenceRule } from './schedule-service'

export interface NlpParseResult {
  /** 解析是否成功 */
  success: boolean
  /** 解析出的标题 */
  title: string
  /** 开始时间 ISO 8601 */
  startTime: string
  /** 结束时间 ISO 8601 */
  endTime: string
  /** 是否全天事件 */
  allDay?: boolean
  /** 地点 */
  location?: string
  /** 分类 */
  category?: string
  /** 标签 */
  tags?: string[]
  /** 重复规则 */
  recurrence?: RecurrenceRule
  /** 原始输入中未识别的部分 */
  remainingText?: string
  /** 解析置信度 0-1 */
  confidence: number
  /** 解析失败时的错误信息 */
  error?: string
}

// ===== 时间关键词映射 =====

const TIME_PATTERNS = {
  // 相对日期
  relativeDate: [
    { pattern: /今天|今日/, offset: 0 },
    { pattern: /明天|明日/, offset: 1 },
    { pattern: /后天/, offset: 2 },
    { pattern: /大后天/, offset: 3 },
    { pattern: /昨天/, offset: -1 },
  ],
  // 星期
  weekday: [
    { pattern: /周[一1]/, day: 1 },
    { pattern: /周[二2]/, day: 2 },
    { pattern: /周[三3]/, day: 3 },
    { pattern: /周[四4]/, day: 4 },
    { pattern: /周[五5]/, day: 5 },
    { pattern: /周[六6]/, day: 6 },
    { pattern: /周[日天日]/, day: 0 },
    { pattern: /下[个]?周[一1]/, day: 1, nextWeek: true },
    { pattern: /下[个]?周[二2]/, day: 2, nextWeek: true },
    { pattern: /下[个]?周[三3]/, day: 3, nextWeek: true },
    { pattern: /下[个]?周[四4]/, day: 4, nextWeek: true },
    { pattern: /下[个]?周[五5]/, day: 5, nextWeek: true },
    { pattern: /下[个]?周[六6]/, day: 6, nextWeek: true },
    { pattern: /下[个]?周[日天]/, day: 0, nextWeek: true },
  ],
  // 时间段
  timeOfDay: [
    { pattern: /早上|早晨|上午/, hour: 9, defaultMinute: 0 },
    { pattern: /中午|午间/, hour: 12, defaultMinute: 0 },
    { pattern: /下午/, hour: 14, defaultMinute: 0 },
    { pattern: /傍晚|晚上|晚间/, hour: 19, defaultMinute: 0 },
    { pattern: /凌晨/, hour: 6, defaultMinute: 0 },
    { pattern: /半夜|深夜/, hour: 23, defaultMinute: 0 },
  ],
  // 具体时间 HH:MM
  specificTime: /(\d{1,2})[:\：](\d{2})/,
  // 持续时间
  duration: [
    { pattern: /(\d+)\s*小时/, unit: 'hour' as const },
    { pattern: /(\d+)\s*分钟/, unit: 'minute' as const },
    { pattern: /(\d+)\s*分/, unit: 'minute' as const },
    { pattern: /半\s*小时/, unit: 'halfHour' as const },
    { pattern: /一\s*小时/, unit: 'hour' as const, value: 1 },
    { pattern: /两\s*小时/, unit: 'hour' as const, value: 2 },
    { pattern: /三\s*小时/, unit: 'hour' as const, value: 3 },
  ],
  // 重复
  recurrence: [
    { pattern: /每天|每日/, rule: { frequency: 'daily' as const } },
    { pattern: /每周[一1]/, rule: { frequency: 'weekly' as const, byDay: ['MO'] } },
    { pattern: /每周[二2]/, rule: { frequency: 'weekly' as const, byDay: ['TU'] } },
    { pattern: /每周[三3]/, rule: { frequency: 'weekly' as const, byDay: ['WE'] } },
    { pattern: /每周[四4]/, rule: { frequency: 'weekly' as const, byDay: ['TH'] } },
    { pattern: /每周[五5]/, rule: { frequency: 'weekly' as const, byDay: ['FR'] } },
    { pattern: /每周[六6]/, rule: { frequency: 'weekly' as const, byDay: ['SA'] } },
    { pattern: /每周[日天]/, rule: { frequency: 'weekly' as const, byDay: ['SU'] } },
    { pattern: /每周/, rule: { frequency: 'weekly' as const } },
    { pattern: /每月/, rule: { frequency: 'monthly' as const } },
    { pattern: /每年/, rule: { frequency: 'yearly' as const } },
  ],
  // 重复次数
  recurrenceCount: /(\d+)\s*[次个周]/,
  // 持续周数
  recurrenceWeeks: /(\d+)\s*周/,
}

// ===== 分类关键词 =====

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  work: ['工作', '会议', '客户', '项目', '汇报', '面试', '出差', '办公', '业务'],
  personal: ['个人', '自己', '私事', '独处'],
  family: ['家庭', '家人', '孩子', '父母', '亲子', '家务'],
  health: ['健身', '运动', '跑步', '瑜伽', '游泳', '医院', '体检', '看病', '健康'],
  learning: ['学习', '课程', '培训', '读书', '考试', '复习', '进修'],
  social: ['聚会', '朋友', '聚餐', '约会', '社交', '派对', '活动'],
  finance: ['理财', '投资', '银行', '保险', '税务', '财务'],
}

// ===== 地点提取 =====

const LOCATION_PATTERNS = [
  /在\s*([^，,。\s]{2,20})/,
  /([^，,。\s]{2,20})(?:会议室|办公室|教室|场馆|酒店|餐厅|咖啡馆|健身房|医院|机场|车站)/,
]

// ===== 解析函数 =====

function getRelativeDate(baseDate: Date, offset: number): Date {
  const d = new Date(baseDate)
  d.setDate(d.getDate() + offset)
  return d
}

function getWeekdayDate(baseDate: Date, targetDay: number, nextWeek: boolean = false): Date {
  const d = new Date(baseDate)
  const currentDay = d.getDay()
  let diff = targetDay - currentDay
  if (nextWeek || diff <= 0) {
    diff += 7
  }
  d.setDate(d.getDate() + diff)
  return d
}

function parseDateTime(text: string, baseDate: Date = new Date()): {
  date: Date
  hasTime: boolean
  remaining: string
} {
  let remaining = text
  let targetDate = new Date(baseDate)
  let hasTime = false

  // 1. 解析相对日期
  for (const { pattern, offset } of TIME_PATTERNS.relativeDate) {
    if (pattern.test(remaining)) {
      targetDate = getRelativeDate(baseDate, offset)
      remaining = remaining.replace(pattern, '')
      break
    }
  }

  // 2. 解析星期
  for (const { pattern, day, nextWeek } of TIME_PATTERNS.weekday) {
    if (pattern.test(remaining)) {
      targetDate = getWeekdayDate(baseDate, day, nextWeek)
      remaining = remaining.replace(pattern, '')
      break
    }
  }

  // 3. 解析具体日期（如 12月25日）
  const datePattern = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/
  const dateMatch = remaining.match(datePattern)
  if (dateMatch) {
    const month = parseInt(dateMatch[1]!) - 1
    const day = parseInt(dateMatch[2]!)
    targetDate = new Date(targetDate.getFullYear(), month, day)
    remaining = remaining.replace(datePattern, '')
  }

  // 4. 解析时间段关键词
  for (const { pattern, hour, defaultMinute } of TIME_PATTERNS.timeOfDay) {
    if (pattern.test(remaining)) {
      targetDate.setHours(hour, defaultMinute, 0, 0)
      hasTime = true
      remaining = remaining.replace(pattern, '')
      break
    }
  }

  // 5. 解析具体时间 HH:MM
  const timeMatch = remaining.match(TIME_PATTERNS.specificTime)
  if (timeMatch) {
    const hour = parseInt(timeMatch[1]!)
    const minute = parseInt(timeMatch[2]!)
    targetDate.setHours(hour, minute, 0, 0)
    hasTime = true
    remaining = remaining.replace(TIME_PATTERNS.specificTime, '')
  }

  return { date: targetDate, hasTime, remaining }
}

function parseDuration(text: string): { duration: number; remaining: string } {
  let remaining = text
  let duration = 60 // 默认 1 小时

  for (const { pattern, unit, value } of TIME_PATTERNS.duration) {
    const match = remaining.match(pattern)
    if (match) {
      if (unit === 'halfHour') {
        duration = 30
      } else {
        const num = value ?? parseInt(match[1]!)
        duration = unit === 'hour' ? num * 60 : num
      }
      remaining = remaining.replace(pattern, '')
      break
    }
  }

  return { duration, remaining }
}

function parseRecurrence(text: string): { rule?: RecurrenceRule; remaining: string } {
  let remaining = text
  let rule: RecurrenceRule | undefined

  for (const { pattern, rule: r } of TIME_PATTERNS.recurrence) {
    if (pattern.test(remaining)) {
      rule = { ...r }
      remaining = remaining.replace(pattern, '')
      break
    }
  }

  if (rule) {
    // 解析重复次数
    const countMatch = remaining.match(TIME_PATTERNS.recurrenceCount)
    if (countMatch) {
      rule.count = parseInt(countMatch[1]!)
      remaining = remaining.replace(TIME_PATTERNS.recurrenceCount, '')
    }

    // 解析持续周数（作为 until）
    const weeksMatch = remaining.match(TIME_PATTERNS.recurrenceWeeks)
    if (weeksMatch) {
      const weeks = parseInt(weeksMatch[1]!)
      const until = new Date()
      until.setDate(until.getDate() + weeks * 7)
      rule.until = until.toISOString()
      remaining = remaining.replace(TIME_PATTERNS.recurrenceWeeks, '')
    }
  }

  return { rule, remaining }
}

function detectCategory(text: string): string | undefined {
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        return category
      }
    }
  }
  return undefined
}

function detectLocation(text: string): string | undefined {
  for (const pattern of LOCATION_PATTERNS) {
    const match = text.match(pattern)
    if (match) {
      return match[1]
    }
  }
  return undefined
}

function extractTitle(text: string): string {
  // 移除时间、地点、重复等标记后，剩余内容作为标题
  let title = text
    .replace(/今天|明天|后天|大后天|昨天/, '')
    .replace(/周[一二三四五六日天]/, '')
    .replace(/下[个]?周[一二三四五六日天]/, '')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]/, '')
    .replace(/早上|早晨|上午|中午|午间|下午|傍晚|晚上|晚间|凌晨|半夜|深夜/, '')
    .replace(/\d{1,2}[:\：]\d{2}/, '')
    .replace(/\d+\s*小时|\d+\s*分钟|\d+\s*分|半\s*小时|一\s*小时|两\s*小时|三\s*小时/, '')
    .replace(/每天|每日|每周[一二三四五六日天]?|每月|每年/, '')
    .replace(/\d+\s*[次个周]/, '')
    .replace(/在\s*[^，,。\s]{2,20}/, '')
    .replace(/[^，,。\s]{2,20}(?:会议室|办公室|教室|场馆|酒店|餐厅|咖啡馆|健身房|医院|机场|车站)/, '')
    .trim()

  // 清理多余标点
  title = title.replace(/^[，,。\s]+|[，,。\s]+$/g, '').trim()

  return title || '未命名日程'
}

// ===== 主解析函数 =====

export function parseScheduleNlp(text: string): NlpParseResult {
  if (!text || text.trim().length === 0) {
    return {
      success: false,
      title: '',
      startTime: '',
      endTime: '',
      confidence: 0,
      error: '输入为空',
    }
  }

  try {
    const input = text.trim()
    const baseDate = new Date()

    // 1. 解析日期时间
    const { date: startDate, hasTime, remaining: afterDate } = parseDateTime(input, baseDate)

    // 2. 解析持续时间
    const { duration, remaining: afterDuration } = parseDuration(afterDate)

    // 3. 解析重复规则
    const { rule, remaining: afterRecurrence } = parseRecurrence(afterDuration)

    // 4. 提取标题
    const title = extractTitle(afterRecurrence)

    // 5. 检测分类
    const category = detectCategory(input)

    // 6. 检测地点
    const location = detectLocation(input)

    // 7. 计算结束时间
    const endDate = new Date(startDate.getTime() + duration * 60000)

    // 8. 如果没有解析到时间，设为全天事件
    const allDay = !hasTime
    if (allDay) {
      startDate.setHours(0, 0, 0, 0)
      endDate.setHours(23, 59, 59, 999)
    }

    // 9. 计算置信度
    let confidence = 0.5
    if (hasTime) confidence += 0.2
    if (category) confidence += 0.1
    if (location) confidence += 0.1
    if (title && title !== '未命名日程') confidence += 0.1

    return {
      success: true,
      title,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString(),
      allDay,
      location,
      category,
      recurrence: rule,
      remainingText: afterRecurrence.trim() || undefined,
      confidence: Math.min(confidence, 1),
    }
  } catch (err) {
    return {
      success: false,
      title: '',
      startTime: '',
      endTime: '',
      confidence: 0,
      error: err instanceof Error ? err.message : '解析失败',
    }
  }
}

// ===== 批量解析 =====

export function parseScheduleNlpBatch(texts: string[]): NlpParseResult[] {
  return texts.map((text) => parseScheduleNlp(text))
}

// ===== 转换为 ScheduleEventInput =====

export function nlpResultToEventInput(result: NlpParseResult): ScheduleEventInput | null {
  if (!result.success) return null

  return {
    title: result.title,
    startTime: result.startTime,
    endTime: result.endTime,
    allDay: result.allDay,
    location: result.location,
    category: result.category as any,
    recurrence: result.recurrence,
  }
}
