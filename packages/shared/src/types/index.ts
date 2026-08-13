/**
 * Shared type definitions for proma
 */

// Placeholder types - will be expanded as needed
export interface Workspace {
  id: string
  name: string
  path: string
}

// 运行时相关类型
export * from './runtime'

// 运行档案（Runtime Span）类型
export * from './runtime-span'

// 渠道（AI 供应商）相关类型
export * from './channel'

// 代理配置相关类型
export * from './proxy'

// Chat 相关类型
export * from './chat'

// Agent 相关类型
export * from './agent'

// 统一任务事件契约（消费端统一消费）
export * from './app-event'

// 主进程系统通知类型
export * from './system-notification'

// 运行记录（Context Hub 起点）
export * from './run-record'

// Token 消耗统计类型
export * from './token-usage'

// Goal（目标）状态层类型
export * from './goal'

// 扩展（Extension）Manifest 与生命周期类型
export * from './plugin'

// Agent Provider 适配器接口
export * from './agent-provider'

// 环境检测相关类型
export * from './environment'

// 第三方安装包（Git、Node.js 等）相关类型
export * from './installer'

// GitHub Release 相关类型
export * from './github'

// 系统提示词相关类型
export * from './system-prompt'

// macOS 灵动岛通知相关类型
export * from './dynamic-island'

// Chat 工具（function calling）相关类型
export * from './chat-tool'

// 飞书集成相关类型
export * from './feishu'

// 钉钉集成相关类型
export * from './dingtalk'

// 微信集成相关类型
export * from './wechat'

// 主动协作与本地调度相关类型
export * from './proactive'

// Workflow 模式相关类型
export * from './workflow'

// 工作模块（项目管理 / 日程管家 / 日历同步）IPC 通道与类型
export * from './work-module'

// 营销 Campaign / KOL 类型（ma-tools 迁移用）
export * from './campaign-types'

// Agent Card 统一身份模型（身份层种子，兼容 AI 员工档案与通用 Agent）
export * from './agent-card'
