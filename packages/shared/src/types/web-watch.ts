/**
 * 项目外网扫描的监控源类型与 Agent-Reach 渠道模板。
 *
 * 主进程采集层（project-web-watch-agent-reach）与渲染进程面板共用这一份
 * 模板元数据；保存校验以主进程为准，模板表漂移时保存会被拒绝。
 */

/** 一条结构化监控源：绑定 agent-reach 的某个渠道动作。 */
export interface WebWatchSource {
  id: string
  /** 一期白名单渠道，见 AGENT_REACH_WATCH_TEMPLATES。 */
  channel: string
  action: string
  params: Record<string, string | number>
  label: string
  enabled: boolean
  addedAt: number
}

/** 单源失败明细，记录在扫描流水的 sourceErrors 里。 */
export interface WebWatchSourceError {
  sourceId: string
  channel: string
  code: string
  message: string
}

/** 一期免登录渠道的动作模板。 */
export interface AgentReachWatchTemplate {
  channel: string
  action: string
  /** 模板展示名（面板下拉用）。 */
  label: string
  /** 渠道展示名。 */
  channelLabel: string
  /** 必需参数名（按顺序拼成 CLI 位置参数）。 */
  requiredParams: string[]
  /** 可选参数名（拼成 --name value）。 */
  optionalParams: string[]
}

/** 一期渠道白名单：全部免登录；登录渠道待二期验证引导体验后再开。 */
export const AGENT_REACH_WATCH_TEMPLATES: readonly AgentReachWatchTemplate[] = [
  { channel: 'github', action: 'search', label: 'GitHub 关键词搜仓库', channelLabel: 'GitHub', requiredParams: ['query'], optionalParams: ['limit'] },
  { channel: 'github', action: 'read', label: 'GitHub 仓库/议题速览', channelLabel: 'GitHub', requiredParams: ['target'], optionalParams: [] },
  { channel: 'bilibili', action: 'search', label: 'B站关键词新投稿', channelLabel: 'B站', requiredParams: ['query'], optionalParams: ['limit'] },
  { channel: 'bilibili', action: 'hot', label: 'B站热门', channelLabel: 'B站', requiredParams: [], optionalParams: ['limit'] },
  { channel: 'v2ex', action: 'node', label: 'V2EX 节点新帖', channelLabel: 'V2EX', requiredParams: ['node_name'], optionalParams: ['limit'] },
  { channel: 'v2ex', action: 'hot', label: 'V2EX 热议', channelLabel: 'V2EX', requiredParams: [], optionalParams: ['limit'] },
]

/** 参数中文名，面板表单用；缺省回退参数名本身。 */
export const AGENT_REACH_PARAM_LABELS: Record<string, string> = {
  query: '关键词',
  target: '目标（仓库名或链接）',
  node_name: '节点名',
  limit: '最多条数',
}
