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
import { FolderKanban, Users, Megaphone, Globe2, BookOpen, BarChart3, Radio, FlaskConical, type LucideIcon } from 'lucide-react'
import type { ActiveView } from '@/atoms/active-view'
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

/** 工作模块注册表（当前 3 个核心模块；日程管家已并入项目管理子视图；主动协作统一收敛到 Proactive Center） */
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
    core: true,
    description: '本地草稿、排程与受控外发审批（不连接真实平台）',
  },
  {
    id: 'research',
    label: '研究',
    icon: FlaskConical,
    core: true,
    description: '从文献到稿件的可追溯研究工作台',
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
}
