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
import { FolderKanban, Users, Megaphone, Globe2, BookOpen, BarChart3, Radio, FlaskConical, type LucideIcon } from 'lucide-react'
import type { ActiveView } from '@/atoms/active-view'
import { enabledCapabilitiesAtom, isCapabilityEnabled, type CapabilityId } from '@/atoms/marketing-atoms'
const CalendarModuleView = lazy(() => import('@/components/calendar/CalendarModuleView').then((module) => ({ default: module.CalendarModuleView })))
const ProjectView = lazy(() => import('@/components/projects/ProjectView').then((module) => ({ default: module.ProjectView })))
const KnowledgeModuleView = lazy(() => import('@/components/knowledge/KnowledgeModuleView').then((module) => ({ default: module.KnowledgeModuleView })))
const AnalysisModuleView = lazy(() => import('@/components/analysis/AnalysisModuleView').then((module) => ({ default: module.AnalysisModuleView })))
const InfluencerModuleView = lazy(() => import('@/components/influencer/InfluencerModuleView').then((module) => ({ default: module.InfluencerModuleView })))
const PaidMediaModuleView = lazy(() => import('@/components/paid-media/PaidMediaModuleView').then((module) => ({ default: module.PaidMediaModuleView })))
const OutboundSourcingModuleView = lazy(() => import('@/components/outbound-sourcing/OutboundSourcingModuleView').then((module) => ({ default: module.OutboundSourcingModuleView })))
const CapabilitiesView = lazy(() => import('@/components/marketing/CapabilitiesView').then((module) => ({ default: module.CapabilitiesView })))
const NewMediaModuleView = lazy(() => import('@/components/new-media/NewMediaModuleView').then((module) => ({ default: module.NewMediaModuleView })))
const ResearchWorkspace = lazy(() => import('@/components/academic/ResearchWorkspace').then((module) => ({ default: module.ResearchWorkspace })))
const WorkspaceConfigView = lazy(() => import('@/components/settings/WorkspaceConfigView').then((module) => ({ default: module.WorkspaceConfigView })))

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

/** 工作模块注册表（核心模块：知识库 / 分析引擎 / 项目管理；
 * 新媒体运营与研究已转为订阅式领域包，启用后在侧栏「领域能力包」分组出现） */
export const WORK_MODULE_REGISTRY: WorkModuleMeta[] = [
  {
    id: 'knowledge',
    label: '知识库',
    icon: BookOpen,
    core: true,
    description: '索引本地 Markdown，支持全文检索、标签与图谱',
  },
  {
    id: 'analysis',
    label: '分析引擎',
    icon: BarChart3,
    core: true,
    description: '时间使用与生产力分析报告',
  },
  {
    id: 'projects',
    label: '项目管理',
    icon: FolderKanban,
    core: true,
    description: '项目 / 任务 / 看板 / 会议纪要 / 风险报告',
  },
  {
    id: 'new-media',
    label: '新媒体运营',
    icon: Radio,
    core: false,
    group: 'business-domains',
    description: '本地草稿、排程与受控外发审批（不连接真实平台，订阅式领域包）',
  },
  {
    id: 'research',
    label: '研究',
    icon: FlaskConical,
    core: false,
    group: 'business-domains',
    description: '从文献到稿件的可追溯研究工作台（订阅式领域包）',
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
  {
    id: 'outbound-sourcing',
    label: '出海 sourcing',
    icon: Globe2,
    core: false,
    group: 'business-domains',
    description: '海外买家发现、线索核验与外联推进',
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
  knowledge: KnowledgeModuleView,
  analysis: AnalysisModuleView,
  // calendar 已从 WORK_MODULE_REGISTRY 移除（日程管家并入项目管理顶层子视图），
  // 此处保留映射防止旧持久化 activeView='calendar' 导致白屏。
  calendar: CalendarModuleView,
  projects: ProjectView,
  research: ResearchWorkspace,
  influencer: InfluencerModuleView,
  'paid-media': PaidMediaModuleView,
  'outbound-sourcing': OutboundSourcingModuleView,
  'new-media': NewMediaModuleView,
  capabilities: CapabilitiesView,
  // 工作空间配置与其它工作模块对齐：以右侧主区独立页面呈现（侧边栏入口切换视图，不再弹设置窗）。
  // 仅登记视图映射，不进入 WORK_MODULE_REGISTRY——它由侧边栏的独立入口按钮渲染（带能力计数徽标）。
  'workspace-config': WorkspaceConfigView,
}
