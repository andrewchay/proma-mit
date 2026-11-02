/**
 * Agent 自动化事件路由器（借鉴卡兹克「事件中台」设计）
 *
 * 核心思想：把任务发生的起点从人身上拿掉，用信号触发 Agent。
 * 所有触发源（IM 消息 / 内部事件 / 未来 webhook）统一归一为 AgentAutomationEvent，
 * 按声明式规则文件 event-rules.json 路由，新增一类自动化只需加一条规则。
 *
 * 中台三件套：
 * - 去重：dedupeKey 指纹（缺省 source:type:target）+ 时间窗，网络重发/补消息不再重复触发
 * - 分组并发：同 group 串行（parallel 缺省 1）、上限可配，防止同一件事多个 Agent 同时改
 * - 通知策略 tell：needed（默认，仅失败时打扰）/ always / silent，保护人的注意力
 *
 * 范围说明：执行目标 v1 支持 workflow-event（转发已发布 Workflow 的事件触发）与 log；
 * 会话直启形态预留字段（skill/ask）暂不启用。webhook 入站在桌面端无 HTTP listener，后续接 companion-server。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfigDir, getEventRulesPath } from './config-paths'
import type { WorkflowRun } from '@gravitas/shared'

/** 执行目标函数签名（依赖注入点，测试可替换；缺省转发 Workflow 事件触发） */
export type WorkflowEventExecutor = (eventName: string, payload: Record<string, unknown>) => Promise<WorkflowRun[]>

// ===== 事件与规则类型 =====

/** 归一化后的自动化事件（对齐中台的「从哪来 / 什么类型 / 对象是谁 / 一句话摘要 / 回链」） */
export interface AgentAutomationEvent {
  /** 事件来源，如 '飞书' | '钉钉' | 'workflow' | 'webhook' */
  source: string
  /** 事件类型，建议点分格式，如 'im.message' | 'feedback.new' | 'alert.fired' */
  type: string
  /** 对象标识（群 / 项目 / 服务等），参与缺省去重指纹 */
  target?: string
  /** 一句话摘要 */
  summary: string
  /** 回到原处的链接 */
  backlink?: string
  /** 发生时间（缺省 Date.now()） */
  occurredAt?: number
  /** 去重指纹；缺省 `${source}:${type}:${target}` */
  dedupeKey?: string
  /** 透传给执行目标的载荷 */
  payload?: Record<string, unknown>
}

/** 规则执行目标。v1：workflow-event / log；session 直启为预留形态。 */
export type EventRouteTarget =
  | { kind: 'workflow-event'; eventName: string }
  | { kind: 'log' }

/** 通知策略：needed=仅失败时打扰（默认）；always=成功也通知；silent=从不 */
export type EventTellPolicy = 'needed' | 'always' | 'silent'

/** 声明式路由规则（对齐中台 rules.json 的 when→to/cwd/skill/ask/group/parallel/tell） */
export interface EventRouteRule {
  /** 规则名（人类可读） */
  name: string
  /** 匹配条件：source 精确等于（缺省不限）；types 命中其一（缺省不限） */
  when: { source?: string; types?: string[] }
  /** 执行目标 */
  to: EventRouteTarget
  /** 预留：绑定的 Skill 名称 */
  skill?: string
  /** 预留：给 Agent 的一句话指令 */
  ask?: string
  /** 分组名：同组按 parallel 限流 */
  group?: string
  /** 同组最大并发，缺省 1（同组串行） */
  parallel?: number
  /** 通知策略，缺省 'needed' */
  tell?: EventTellPolicy
  /** 缺省 true */
  enabled?: boolean
}

/** event-rules.json 文件结构 */
export interface EventRulesFile {
  rules: EventRouteRule[]
}

export type DispatchOutcomeStatus =
  | 'matched'
  | 'no_rule'
  | 'duplicate'
  | 'concurrency_limited'
  | 'unsupported_target'
  | 'failed'

export interface DispatchOutcome {
  ruleName: string
  status: DispatchOutcomeStatus
  detail?: string
}

/** 路由器对外的通知消息（tell 策略命中时回调） */
export interface EventNotifyMessage {
  ruleName: string
  ok: boolean
  text: string
}

// ===== 规则文件读写 =====

/** 校验单条规则，返回错误列表（空数组 = 合法） */
export function validateEventRule(rule: EventRouteRule): string[] {
  const errors: string[] = []
  if (!rule.name?.trim()) errors.push('规则缺少 name')
  if (!rule.when || typeof rule.when !== 'object') errors.push('规则缺少 when')
  else {
    if (rule.when.source !== undefined && typeof rule.when.source !== 'string') errors.push('when.source 必须是字符串')
    if (rule.when.types !== undefined && (!Array.isArray(rule.when.types) || rule.when.types.some((t) => typeof t !== 'string'))) {
      errors.push('when.types 必须是字符串数组')
    }
  }
  if (!rule.to || typeof rule.to !== 'object') {
    errors.push('规则缺少 to')
  } else if (rule.to.kind === 'workflow-event') {
    if (!rule.to.eventName?.trim()) errors.push('to.eventName 不能为空')
  } else if (rule.to.kind !== 'log') {
    errors.push(`不支持的 to.kind: ${(rule.to as { kind?: string }).kind}`)
  }
  if (rule.parallel !== undefined && (!Number.isInteger(rule.parallel) || rule.parallel < 1)) {
    errors.push('parallel 必须是不小于 1 的整数')
  }
  if (rule.tell !== undefined && !['needed', 'always', 'silent'].includes(rule.tell)) {
    errors.push('tell 只支持 needed / always / silent')
  }
  return errors
}

/** 读取规则文件；不存在或缺省结构返回空数组；损坏文件打印警告并返回空数组（不阻断业务） */
export function readEventRules(path: string = getEventRulesPath()): EventRouteRule[] {
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<EventRulesFile>
    if (!Array.isArray(raw.rules)) return []
    return raw.rules
  } catch (error) {
    console.warn(`[EventRouter] 规则文件解析失败，按空规则处理: ${path}`, error)
    return []
  }
}

/** 写入规则文件（目录不存在则创建） */
export function writeEventRules(rules: EventRouteRule[], path: string = getEventRulesPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ rules } satisfies EventRulesFile, null, 2), 'utf-8')
}

/** 生成默认规则文件模板（文件不存在时调用方可用） */
export function defaultEventRulesFile(): EventRulesFile {
  return {
    rules: [
      {
        name: '示例：IM 消息转 Workflow（默认停用）',
        when: { source: '飞书', types: ['im.message'] },
        to: { kind: 'workflow-event', eventName: 'im.message' },
        group: 'im-message',
        parallel: 2,
        tell: 'silent',
        enabled: false,
      },
    ],
  }
}

/** 规则是否命中事件 */
function ruleMatches(rule: EventRouteRule, event: AgentAutomationEvent): boolean {
  if (rule.enabled === false) return false
  const when = rule.when ?? {}
  if (when.source !== undefined && when.source !== event.source) return false
  if (when.types !== undefined && when.types.length > 0 && !when.types.includes(event.type)) return false
  return true
}

// ===== 路由器 =====

export class EventRouter {
  /** 去重时间窗（毫秒） */
  private dedupeWindowMs = 10 * 60_000
  /** dedupeKey → 上次触发时间 */
  private recentDispatch = new Map<string, number>()
  /** group → 正在执行的数量 */
  private groupRunning = new Map<string, number>()
  /** 通知回调（tell 命中时调用；由 IM Bridge 注册，避免与具体渠道硬耦合） */
  private notifyHandler?: (message: EventNotifyMessage) => void
  /** workflow-event 执行器（缺省懒加载 workflow-event-service，避免测试期连带重依赖） */
  private workflowExecutor?: WorkflowEventExecutor

  constructor(workflowExecutor?: WorkflowEventExecutor) {
    this.workflowExecutor = workflowExecutor
  }

  private async executeWorkflowEvent(eventName: string, payload: Record<string, unknown>): Promise<WorkflowRun[]> {
    if (this.workflowExecutor) return this.workflowExecutor(eventName, payload)
    const { triggerWorkflowEvent } = await import('./workflow-event-service')
    return triggerWorkflowEvent(eventName, payload)
  }

  /** 注册通知回调（IM Bridge 连接后调用） */
  setNotifyHandler(handler: (message: EventNotifyMessage) => void): void {
    this.notifyHandler = handler
  }

  clearNotifyHandler(): void {
    this.notifyHandler = undefined
  }

  /** 测试辅助：调整去重窗口 */
  setDedupeWindowMs(ms: number): void {
    this.dedupeWindowMs = ms
  }

  /** 当前某分组执行中数量（观测用） */
  runningCount(group: string): number {
    return this.groupRunning.get(group) ?? 0
  }

  private notify(rule: EventRouteRule, ok: boolean, text: string): void {
    if (rule.tell === 'silent') return
    if (rule.tell === 'always' || !ok) {
      const message: EventNotifyMessage = { ruleName: rule.name, ok, text }
      try {
        this.notifyHandler?.(message)
      } catch (error) {
        console.warn('[EventRouter] 通知回调失败:', error)
      }
    }
  }

  /**
   * 统一事件入口：去重 → 规则匹配 → 分组并发门 → 执行 → 通知。
   * 无规则命中时零副作用直接返回（未配置规则的部署无任何行为变化）。
   */
  async dispatch(event: AgentAutomationEvent, now: number = Date.now()): Promise<DispatchOutcome[]> {
    const occurredAt = event.occurredAt ?? now
    const dedupeKey = event.dedupeKey?.trim() || `${event.source}:${event.type}:${event.target ?? ''}`

    // 清理过期去重记录，防止长驻进程内存缓慢膨胀
    for (const [key, ts] of this.recentDispatch) {
      if (now - ts > this.dedupeWindowMs) this.recentDispatch.delete(key)
    }

    const rules = readEventRules()
    const matched = rules.filter((rule) => ruleMatches(rule, event))
    if (matched.length === 0) return [{ ruleName: '', status: 'no_rule' }]

    // 同一事件指纹在窗口内只放行一次（跨规则共享去重）
    if (this.recentDispatch.has(dedupeKey)) {
      return matched.map((rule) => ({ ruleName: rule.name, status: 'duplicate' as const, detail: `窗口内重复事件: ${dedupeKey}` }))
    }
    this.recentDispatch.set(dedupeKey, now)

    const outcomes: DispatchOutcome[] = []
    for (const rule of matched) {
      outcomes.push(await this.executeRule(rule, event, occurredAt))
    }
    return outcomes
  }

  private async executeRule(rule: EventRouteRule, event: AgentAutomationEvent, occurredAt: number): Promise<DispatchOutcome> {
    // 分组并发门
    const group = rule.group?.trim() || rule.name
    const limit = rule.parallel ?? 1
    const running = this.groupRunning.get(group) ?? 0
    if (running >= limit) {
      return { ruleName: rule.name, status: 'concurrency_limited', detail: `分组「${group}」并发已满（${running}/${limit}）` }
    }

    this.groupRunning.set(group, running + 1)
    try {
      return await this.runTarget(rule, event, occurredAt)
    } finally {
      const current = this.groupRunning.get(group) ?? 1
      if (current <= 1) this.groupRunning.delete(group)
      else this.groupRunning.set(group, current - 1)
    }
  }

  private async runTarget(rule: EventRouteRule, event: AgentAutomationEvent, occurredAt: number): Promise<DispatchOutcome> {
    const payload = {
      ...(event.payload ?? {}),
      __event: {
        source: event.source,
        type: event.type,
        target: event.target,
        summary: event.summary,
        backlink: event.backlink,
        occurredAt,
      },
    }

    try {
      if (rule.to.kind === 'workflow-event') {
        const runs = await this.executeWorkflowEvent(rule.to.eventName, payload)
        const detail = runs.length > 0 ? `已触发 ${runs.length} 个 Workflow Run` : '无匹配的已发布 Workflow（事件已按规则放行）'
        this.notify(rule, true, `规则「${rule.name}」：${detail}`)
        return { ruleName: rule.name, status: 'matched', detail }
      }
      if (rule.to.kind === 'log') {
        console.log(`[EventRouter] 规则「${rule.name}」记录事件: ${event.source}/${event.type} ${event.summary}`)
        this.notify(rule, true, `规则「${rule.name}」：事件已记录`)
        return { ruleName: rule.name, status: 'matched', detail: '已记录' }
      }
      return { ruleName: rule.name, status: 'unsupported_target', detail: '未知执行目标 kind' }
    } catch (error) {
      const text = `规则「${rule.name}」执行失败：${error instanceof Error ? error.message : String(error)}`
      this.notify(rule, false, text)
      return { ruleName: rule.name, status: 'failed', detail: text }
    }
  }
}

/** 全局事件路由器单例（主进程共享；IM Bridge 接入 dispatch，通知回调由各 Bridge 注册） */
export const eventRouter = new EventRouter()
