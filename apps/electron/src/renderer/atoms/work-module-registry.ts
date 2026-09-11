/**
 * 工作模块注册表（4.3 模块框架）
 *
 * 统一登记工作模块的元数据与组件，LeftSidebar / MainArea 均由此驱动，
 * 避免新增模块时散落多处硬编码。
 *
 * 新增模块流程：
 * 1. 在 ActiveView 类型（atoms/active-view.ts）追加 id
 * 2. 在此文件追加 { id, label, icon, core, description } 与 WORK_MODULE_VIEWS 映射
 */

import { lazy, type ComponentType } from 'react'
import { atom } from 'jotai'
import { CalendarDays, FolderKanban, Users, Megaphone, type LucideIcon } from 'lucide-react'
import type { ActiveView } from '@/atoms/active-view'
import { enabledCapabilitiesAtom, isCapabilityEnabled, type CapabilityId } from '@/atoms/marketing-atoms'
const CalendarModuleView = lazy(() => import('@/components/calendar/CalendarModuleView').then((module) => ({ default: module.CalendarModuleView })))
const ProjectView = lazy(() => import('@/components/projects/ProjectView').then((module) => ({ default: module.ProjectView })))
const InfluencerModuleView = lazy(() => import('@/components/influencer/InfluencerModuleView').then((module) => ({ default: module.InfluencerModuleView })))
const PaidMediaModuleView = lazy(() => import('@/components/paid-media/PaidMediaModuleView').then((module) => ({ default: module.PaidMediaModuleView })))
const CapabilitiesView = lazy(() => import('@/components/marketing/CapabilitiesView').then((module) => ({ default: module.CapabilitiesView })))

export interface WorkModuleMeta {
  id: ActiveView
  label: string
  icon: LucideIcon
  /** 核心模块：直接显示在工作模块导航；false 收进「更多模块」分组 */
  core: boolean
  /** 扩展分组 ID（非核心模块使用） */
  group?: string
  description?: string
}

/** 工作模块注册表（当前 2 个核心模块；主动协作统一收敛到 Proactive Center） */
export const WORK_MODULE_REGISTRY: WorkModuleMeta[] = [
  {
    id: 'calendar',
    label: '日程管家',
    icon: CalendarDays,
    core: true,
    description: '日程安排、任务看板、多日历同步',
  },
  {
    id: 'projects',
    label: '项目管理',
    icon: FolderKanban,
    core: true,
    description: '项目 / 任务 / 看板 / 会议纪要 / 风险报告',
  },
  {
    id: 'influencer',
    label: '达人',
    icon: Users,
    core: false,
    group: 'marketing',
    description: '达人库 / 稿件审核 / 内容追踪（订阅式领域包）',
  },
  {
    id: 'paid-media',
    label: '广告投放',
    icon: Megaphone,
    core: false,
    group: 'marketing',
    description: '投放计划 / 调控审批 / 调控规则（订阅式领域包）',
  },
]

/** 核心模块（按注册表顺序展示） */
export const CORE_WORK_MODULES: WorkModuleMeta[] = WORK_MODULE_REGISTRY.filter((m) => m.core)

/** 扩展模块（收进「更多模块」分组） */
export const EXTENDED_WORK_MODULES: WorkModuleMeta[] = WORK_MODULE_REGISTRY.filter((m) => !m.core)

/** 各工作模块所需的订阅能力（未登记 = 无需订阅，始终可见） */
const MODULE_REQUIRED_CAPABILITY: Partial<Record<ActiveView, CapabilityId>> = {
  influencer: 'influencer',
  'paid-media': 'paid-media',
}

/**
 * 订阅门控后的可见工作模块（派生自 enabledCapabilitiesAtom）。
 * 订阅式领域包：未订阅不出现在侧边栏导航（取消订阅即消失）。
 */
export const visibleCoreWorkModulesAtom = atom((get) => {
  const caps = get(enabledCapabilitiesAtom)
  return CORE_WORK_MODULES.filter((m) => {
    const required = MODULE_REQUIRED_CAPABILITY[m.id]
    return !required || isCapabilityEnabled(caps, required)
  })
})

export const visibleExtendedWorkModulesAtom = atom((get) => {
  const caps = get(enabledCapabilitiesAtom)
  return EXTENDED_WORK_MODULES.filter((m) => {
    const required = MODULE_REQUIRED_CAPABILITY[m.id]
    return !required || isCapabilityEnabled(caps, required)
  })
})

/** 视图映射：工作模块 id → 渲染组件 */
export const WORK_MODULE_VIEWS: Record<string, ComponentType> = {
  calendar: CalendarModuleView,
  projects: ProjectView,
  influencer: InfluencerModuleView,
  'paid-media': PaidMediaModuleView,
  capabilities: CapabilitiesView,
}
