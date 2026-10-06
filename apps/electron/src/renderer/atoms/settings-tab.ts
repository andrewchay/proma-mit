/**
 * Settings Tab Atom - 设置标签页状态
 *
 * 管理设置面板中当前激活的标签页（4.2 设置整合后的 12 个 Tab）：
 * - general: 通用与外观（含语音输入、扩展）
 * - shortcuts: 快捷键管理
 * - about: 关于与帮助（含教程）
 * - channels: 模型配置（含网络代理、视觉中转）
 * - agent: Agent 配置
 * - tools: 工具与提示词（Chat 工具 + 提示词管理）
 * - automation: 设备控制（Computer Use）
 * - bots: 远程连接（飞书/钉钉/微信/手机远程）
 * - calendar: 日历同步
 * - data: 数据与用量（磁盘管理、数据迁移、Token 统计）
 * - privacy: 隐私与审计（数据采集、操作审计）
 * - account: 账户与团队（订阅、企业版、工作区成员）
 */

import { atom } from 'jotai'

export type SettingsTab =
  | 'general'
  | 'shortcuts'
  | 'about'
  | 'channels'
  | 'agent'
  | 'tools'
  | 'automation'
  | 'bots'
  | 'calendar'
  | 'data'
  | 'privacy'
  | 'account'

/** 当前设置标签页（不持久化，每次打开设置默认显示渠道） */
export const settingsTabAtom = atom<SettingsTab>('channels')

/** 设置浮窗是否打开 */
export const settingsOpenAtom = atom(false)

/** 渠道创建表单是否有未保存内容（用于拦截导航离开） */
export const channelFormDirtyAtom = atom(false)

/** 外部请求关闭设置面板（如 Cmd+W），SettingsPanel 监听后弹出确认对话框 */
export const settingsCloseRequestedAtom = atom(false)
