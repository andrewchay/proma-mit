/**
 * macOS 灵动岛通知（Dynamic Island）类型定义。
 *
 * 设计遵循 weavelynx DynamicIsland 插件的成熟架构：
 * - JS 主进程管业务（队列/计时/配置/路由），原生只管画；
 * - 三源归一：AI 主动调用、Agent 事件自动通知、手动测试共用同一 NotifyRequest；
 * - 同一时刻只显示一条，其余排队；同 id 就地替换（进度刷新不重播入场动画）。
 */

/** 通知等级 → 决定 SF Symbol 与颜色（原生侧映射） */
export type DynamicIslandLevel = 'info' | 'success' | 'warning' | 'error' | 'progress'

/** 通知来源（用于状态面板展示与审计） */
export type DynamicIslandSource = 'ai' | 'agent_event' | 'manual'

/** 单条通知请求（三源归一后的统一形状） */
export interface DynamicIslandNotifyInput {
  /** 业务侧幂等 id；不传时由服务端生成 */
  id?: string
  title: string
  /** 副标题/正文，可省略 */
  body?: string
  level?: DynamicIslandLevel
  /** 常驻（progress=0）；其余默认 4500ms */
  timeoutMs?: number
  /** 点击是否激活并导航（默认 false） */
  activateOnClick?: boolean
  /** 点击后导航到指定会话（activateOnClick 为 true 时有效） */
  sessionId?: string
}

/** 归一化后的内部请求（含服务端补全字段） */
export interface DynamicIslandRequest extends DynamicIslandNotifyInput {
  id: string
  level: DynamicIslandLevel
  timeoutMs: number
  createdAt: number
  source: DynamicIslandSource
}

/** 设置面板状态 */
export interface DynamicIslandState {
  /** 当前平台是否支持（macOS 才为 true） */
  supported: boolean
  /** 渲染进程是否在跑 */
  running: boolean
  /** 总开关 */
  enabled: boolean
  /** 最近 N 条（不持久化） */
  recent: DynamicIslandRequest[]
}

/** 项目静音查询/设置结果 */
export interface DynamicIslandProjectMutedResult {
  muted: boolean
}

/** 通知操作结果 */
export interface DynamicIslandActionResult {
  ok: boolean
  reason?: string
}

/** IPC 通道 */
export const DYNAMIC_ISLAND_IPC_CHANNELS = {
  GET_STATE: 'dynamic-island:get-state',
  SET_ENABLED: 'dynamic-island:set-enabled',
  DISMISS: 'dynamic-island:dismiss',
  TEST: 'dynamic-island:test',
  NOTIFY: 'dynamic-island:notify',
  GET_PROJECT_MUTED: 'dynamic-island:get-project-muted',
  SET_PROJECT_MUTED: 'dynamic-island:set-project-muted',
} as const
